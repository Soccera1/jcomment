const std = @import("std");

const max_body = 8192;
const max_comment_body = 1800;
const max_comments = 512;
const max_site_comments = 5000;
const max_replies_per_root = 50;
const max_author = 80;
const max_username = 80;
const max_email = 254;
const max_token = 200;
const max_thread = 120;
const max_site = 120;
const max_sort = 16;
const schema_marker = ".jcomment-schema-v2";

const Comment = struct {
    id: []u8,
    parent_id: []u8,
    author: []u8,
    body: []u8,
    created_at: []u8,
    score: i32,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    ensureDataDir(allocator) catch |err| switch (err) {
        error.MissingRequiredEnvironment => {
            try jsonError(500, "Internal Server Error", "JCOMMENT_DATA_DIR is required");
            return;
        },
        else => return err,
    };

    const method = try envOr(allocator, "REQUEST_METHOD", "");
    defer allocator.free(method);
    const path = try envOr(allocator, "PATH_INFO", "");
    defer allocator.free(path);
    const query = try envOr(allocator, "QUERY_STRING", "");
    defer allocator.free(query);

    const thread_owned = try queryParam(allocator, query, "thread", "default");
    defer allocator.free(thread_owned);
    const thread = thread_owned[0..@min(thread_owned.len, max_thread)];
    sanitizeThread(thread);

    const configured_site_owned = try envOr(allocator, "JCOMMENT_SITE", "");
    defer allocator.free(configured_site_owned);
    const configured_site = configured_site_owned[0..@min(configured_site_owned.len, max_site)];
    const server_name_owned = try envOr(allocator, "SERVER_NAME", "default");
    defer allocator.free(server_name_owned);
    const server_name = server_name_owned[0..@min(server_name_owned.len, max_site)];
    const site = try allocator.dupe(u8, if (configured_site.len > 0) configured_site else server_name);
    defer allocator.free(site);
    const sort_owned = try queryParam(allocator, query, "sort", "newest");
    defer allocator.free(sort_owned);
    const sort = sort_owned[0..@min(sort_owned.len, max_sort)];

    if (!try validateConfig(allocator)) return;

    if (std.mem.eql(u8, method, "OPTIONS")) {
        try status(204, "No Content");
        return;
    }
    if (std.mem.eql(u8, method, "GET")) {
        try listResponse(allocator, site, thread, sort);
        return;
    }
    if (!try validateUnsafeRequest(allocator, method)) return;

    const request_ip = try clientIp(allocator);
    defer allocator.free(request_ip);

    const body = readRequestBody(allocator) catch |err| switch (err) {
        error.RequestBodyTooLarge => {
            try jsonError(413, "Payload Too Large", "Request body is too large");
            return;
        },
        else => return err,
    };
    defer allocator.free(body);

    if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/signup")) {
        if (!try rateLimit(allocator, "signup", site, request_ip, 5)) return;
        if (!envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true)) {
            try jsonError(403, "Forbidden", "Login is disabled for this site");
            return;
        }
        try handleJsonError(handleSignup(allocator, site, body));
    } else if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/login")) {
        if (!try rateLimit(allocator, "login", site, request_ip, 10)) return;
        if (!envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true)) {
            try jsonError(403, "Forbidden", "Login is disabled for this site");
            return;
        }
        try handleJsonError(handleLogin(allocator, site, body));
    } else if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/reset/request")) {
        if (!try rateLimit(allocator, "reset", site, request_ip, 3)) return;
        try handleJsonError(handleResetRequest(allocator, site, body));
    } else if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/reset/confirm")) {
        if (!try rateLimit(allocator, "reset", site, request_ip, 3)) return;
        try handleJsonError(handleResetConfirm(allocator, site, body));
    } else if (std.mem.eql(u8, method, "POST")) {
        if (!try rateLimit(allocator, "post", site, request_ip, 20)) return;
        if (!try rateLimit(allocator, "post-site", site, request_ip, 60)) return;
        try handleJsonError(handleAdd(allocator, thread, site, sort, body));
    } else if (std.mem.eql(u8, method, "PATCH")) {
        if (!try rateLimit(allocator, "vote", site, request_ip, 60)) return;
        try handleJsonError(handleVote(allocator, thread, site, sort, body));
    } else {
        try jsonError(405, "Method Not Allowed", "Method not allowed");
    }
}

fn stdout() std.fs.File.Writer {
    return std.io.getStdOut().writer();
}

fn status(code: u16, message: []const u8) !void {
    try statusWithCookie(code, message, null);
}

fn statusWithCookie(code: u16, message: []const u8, set_cookie: ?[]const u8) !void {
    const w = stdout();
    try w.print("Status: {d} {s}\r\n", .{ code, message });
    try w.writeAll("Content-Type: application/json; charset=utf-8\r\n");
    if (set_cookie) |cookie| {
        try w.print("Set-Cookie: {s}\r\n", .{cookie});
    }
    const origin = std.process.getEnvVarOwned(std.heap.page_allocator, "JCOMMENT_CORS_ORIGIN") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    if (origin) |value| {
        defer std.heap.page_allocator.free(value);
        if (value.len > 0) {
            if (!validCorsOrigin(value)) return error.InvalidCorsOrigin;
            try w.print("Access-Control-Allow-Origin: {s}\r\n", .{value});
            try w.writeAll("Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS\r\n");
            try w.writeAll("Access-Control-Allow-Headers: authorization, content-type\r\n");
            if (!std.mem.eql(u8, value, "*")) {
                try w.writeAll("Access-Control-Allow-Credentials: true\r\n");
            }
        }
    }
    try w.writeAll("\r\n");
}

fn validCorsOrigin(value: []const u8) bool {
    if (std.mem.eql(u8, value, "*")) return true;
    if (std.mem.indexOfAny(u8, value, "\r\n") != null) return false;
    if (!(std.mem.startsWith(u8, value, "https://") or std.mem.startsWith(u8, value, "http://"))) return false;
    _ = std.Uri.parse(value) catch return false;
    return true;
}

fn jsonError(code: u16, message: []const u8, err: []const u8) !void {
    const w = stdout();
    try status(code, message);
    try w.writeAll("{\"error\":");
    try std.json.stringify(err, .{}, w);
    try w.writeAll("}");
}

fn handleJsonError(result: anyerror!void) !void {
    result catch |err| switch (err) {
        error.InvalidJson => try jsonError(400, "Bad Request", "Invalid JSON"),
        else => return err,
    };
}

fn envOr(allocator: std.mem.Allocator, key: []const u8, fallback: []const u8) ![]u8 {
    return std.process.getEnvVarOwned(allocator, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, fallback),
        else => err,
    };
}

fn envEnabled(allocator: std.mem.Allocator, key: []const u8, fallback: bool) bool {
    const value = envOr(allocator, key, "") catch return fallback;
    defer allocator.free(value);
    if (value.len == 0) return fallback;
    return !(std.mem.eql(u8, value, "0") or std.mem.eql(u8, value, "false") or std.mem.eql(u8, value, "off"));
}

fn validateConfig(allocator: std.mem.Allocator) !bool {
    const login_enabled = envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true);
    const require_login_to_post = envEnabled(allocator, "JCOMMENT_REQUIRE_LOGIN_TO_POST", false);
    const reset_enabled = envEnabled(allocator, "JCOMMENT_PASSWORD_RESET_ENABLED", false);
    const cookie_enabled = envEnabled(allocator, "JCOMMENT_SESSION_COOKIE_ENABLED", false);
    const expose_token = envEnabled(allocator, "JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN", false);
    const mode = emailMode(allocator);
    defer allocator.free(mode);

    var errors = std.ArrayList(u8).init(allocator);
    defer errors.deinit();
    const w = errors.writer();
    var has_error = false;
    if (require_login_to_post and !login_enabled) {
        try w.writeAll("JCOMMENT_REQUIRE_LOGIN_TO_POST requires JCOMMENT_LOGIN_ENABLED; ");
        has_error = true;
    }
    if (reset_enabled and std.mem.eql(u8, mode, "none")) {
        try w.writeAll("JCOMMENT_PASSWORD_RESET_ENABLED requires JCOMMENT_EMAIL_MODE=optional or required; ");
        has_error = true;
    }
    if (reset_enabled) {
        const command = try envOr(allocator, "JCOMMENT_PASSWORD_RESET_COMMAND", "");
        defer allocator.free(command);
        if (command.len == 0) {
            try w.writeAll("JCOMMENT_PASSWORD_RESET_ENABLED requires JCOMMENT_PASSWORD_RESET_COMMAND; ");
            has_error = true;
        }
    }
    if (cookie_enabled and expose_token) {
        try w.writeAll("JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN is not supported when JCOMMENT_SESSION_COOKIE_ENABLED is set; ");
        has_error = true;
    }
    if (!has_error) return true;

    if (envEnabled(allocator, "BROKEN_CONFIG", false)) {
        std.debug.print("Invalid jcomment configuration: {s}BROKEN_CONFIG=1 is unsupported and may break any number of things.\n", .{errors.items});
        return true;
    }
    const message = try std.fmt.allocPrint(allocator, "Invalid jcomment configuration: {s}", .{errors.items});
    defer allocator.free(message);
    try jsonError(500, "Internal Server Error", message);
    return false;
}

fn validateUnsafeRequest(allocator: std.mem.Allocator, method: []const u8) !bool {
    if (!(std.mem.eql(u8, method, "POST") or std.mem.eql(u8, method, "PATCH"))) return true;
    const content_type = try envOr(allocator, "CONTENT_TYPE", "");
    defer allocator.free(content_type);
    if (content_type.len > 0 and !isJsonContentType(content_type)) {
        try jsonError(415, "Unsupported Media Type", "Content-Type must be application/json");
        return false;
    }
    const fetch_site = try envOr(allocator, "HTTP_SEC_FETCH_SITE", "");
    defer allocator.free(fetch_site);
    if (std.mem.eql(u8, fetch_site, "cross-site")) {
        try jsonError(403, "Forbidden", "Cross-site state-changing requests are not allowed");
        return false;
    }
    const origin = try envOr(allocator, "HTTP_ORIGIN", "");
    defer allocator.free(origin);
    if (origin.len == 0 and fetch_site.len == 0 and try hasSessionCookie(allocator)) {
        try jsonError(403, "Forbidden", "Cookie-authenticated state-changing requests require browser origin metadata");
        return false;
    }
    if (origin.len == 0) return true;
    if (try originAllowed(allocator, origin)) return true;
    try jsonError(403, "Forbidden", "Request origin is not allowed");
    return false;
}

fn isJsonContentType(value: []const u8) bool {
    const media_type = std.mem.trim(u8, if (std.mem.indexOfScalar(u8, value, ';')) |index| value[0..index] else value, " \t");
    return std.ascii.eqlIgnoreCase(media_type, "application/json") or std.mem.endsWith(u8, media_type, "+json");
}

fn originAllowed(allocator: std.mem.Allocator, origin: []const u8) !bool {
    const cors_origin = try envOr(allocator, "JCOMMENT_CORS_ORIGIN", "");
    defer allocator.free(cors_origin);
    if (cors_origin.len > 0 and !std.mem.eql(u8, cors_origin, "*") and std.mem.eql(u8, origin, cors_origin)) return true;
    const same_origin = try requestOrigin(allocator);
    defer allocator.free(same_origin);
    return same_origin.len > 0 and std.mem.eql(u8, origin, same_origin);
}

fn requestOrigin(allocator: std.mem.Allocator) ![]u8 {
    const host = try envOr(allocator, "HTTP_HOST", "");
    defer allocator.free(host);
    const name = if (host.len > 0) host else blk: {
        const server_name = try envOr(allocator, "SERVER_NAME", "");
        break :blk server_name;
    };
    defer if (host.len == 0) allocator.free(name);
    if (name.len == 0) return allocator.dupe(u8, "");
    const scheme_env = try envOr(allocator, "REQUEST_SCHEME", "");
    defer allocator.free(scheme_env);
    const https = try envOr(allocator, "HTTPS", "");
    defer allocator.free(https);
    const scheme = if (scheme_env.len > 0) scheme_env else if (std.ascii.eqlIgnoreCase(https, "on") or std.mem.eql(u8, https, "1")) "https" else "http";
    return std.fmt.allocPrint(allocator, "{s}://{s}", .{ scheme, name });
}

fn queryParam(allocator: std.mem.Allocator, query: []const u8, key: []const u8, fallback: []const u8) ![]u8 {
    var it = std.mem.splitScalar(u8, query, '&');
    while (it.next()) |part| {
        if (part.len <= key.len or part[key.len] != '=') continue;
        if (std.mem.eql(u8, part[0..key.len], key)) {
            return urlDecode(allocator, part[key.len + 1 ..]);
        }
    }
    return allocator.dupe(u8, fallback);
}

fn urlDecode(allocator: std.mem.Allocator, input: []const u8) ![]u8 {
    var out = try allocator.alloc(u8, input.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < input.len) {
        if (input[i] == '%' and i + 2 < input.len) {
            const hi = std.fmt.charToDigit(input[i + 1], 16) catch 255;
            const lo = std.fmt.charToDigit(input[i + 2], 16) catch 255;
            if (hi != 255 and lo != 255) {
                out[n] = @as(u8, @intCast((hi << 4) | lo));
                n += 1;
                i += 3;
                continue;
            }
        }
        out[n] = if (input[i] == '+') ' ' else input[i];
        n += 1;
        i += 1;
    }
    return allocator.realloc(out, n);
}

fn sanitizeThread(thread: []u8) void {
    for (thread) |*c| {
        if (!(std.ascii.isAlphanumeric(c.*) or c.* == '-' or c.* == '_')) c.* = '_';
    }
}


fn ensureDataDir(allocator: std.mem.Allocator) !void {
    const dir = try requiredEnv(allocator, "JCOMMENT_DATA_DIR");
    defer allocator.free(dir);
    try std.fs.cwd().makePath(dir);
    if (std.fs.cwd().openDir(dir, .{ .iterate = true })) |data_dir| {
        var mutable_dir = data_dir;
        defer mutable_dir.close();
        mutable_dir.chmod(0o700) catch {};
    } else |_| {}
    if (try schemaReady(allocator, dir)) return;
    try sqliteExec(allocator,
        \\create table if not exists comments(id text primary key, site text not null default 'default', thread text not null, parent_id text not null, author text not null, body text not null, created_at text not null, score integer not null default 0);
        \\create index if not exists comments_thread_idx on comments(thread, created_at);
        \\create table if not exists votes(site text not null default 'default', thread text not null, comment_id text not null, identity text not null, vote_slot integer not null default 0);
        \\create index if not exists votes_identity_idx on votes(thread, comment_id, identity);
        \\create table if not exists accounts(site text not null, username text not null, email text not null, password_hash text not null, created_at text not null, unique(site, username));
        \\create table if not exists sessions(token text primary key, site text not null, username text not null, expires_at integer not null default 0);
        \\create table if not exists resets(site text not null, username text not null, token text not null, expires_at integer not null default 0);
        \\create table if not exists rate_limits(key text primary key, count integer not null, reset_at integer not null);
    );
    sqliteExecIgnoreError(allocator, "alter table comments add column site text not null default 'default';") catch {};
    sqliteExecIgnoreError(allocator, "alter table votes add column site text not null default 'default';") catch {};
    sqliteExecIgnoreError(allocator, "alter table votes add column vote_slot integer not null default 0;") catch {};
    sqliteExecIgnoreError(allocator, "alter table sessions add column expires_at integer not null default 0;") catch {};
    sqliteExecIgnoreError(allocator, "alter table resets add column expires_at integer not null default 0;") catch {};
    try sqliteExec(allocator,
        \\update votes
        \\set vote_slot = (
        \\  select count(*) - 1
        \\  from votes as earlier
        \\  where earlier.site = votes.site
        \\    and earlier.thread = votes.thread
        \\    and earlier.comment_id = votes.comment_id
        \\    and earlier.identity = votes.identity
        \\    and earlier.rowid <= votes.rowid
        \\);
    );
    try sqliteExec(allocator, "create index if not exists comments_site_thread_idx on comments(site, thread, created_at);");
    try sqliteExec(allocator, "create unique index if not exists votes_identity_slot_idx on votes(site, thread, comment_id, identity, vote_slot);");
    try sqliteExec(allocator, "create unique index if not exists accounts_site_username_key_idx on accounts(site, lower(username));");
    try sqliteExec(allocator, "update sessions set expires_at = (strftime('%s','now') * 1000) + 2592000000 where expires_at = 0;");
    try sqliteExec(allocator, "update resets set expires_at = (strftime('%s','now') * 1000) + 3600000 where expires_at = 0;");
    try cleanupExpiredAuth(allocator);
    try writeSchemaMarker(allocator, dir);
}

fn schemaReady(allocator: std.mem.Allocator, dir: []const u8) !bool {
    const db_path = try std.fmt.allocPrint(allocator, "{s}/jcomment.sqlite3", .{dir});
    defer allocator.free(db_path);
    const marker_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir, schema_marker });
    defer allocator.free(marker_path);
    std.fs.cwd().access(db_path, .{}) catch return false;
    std.fs.cwd().access(marker_path, .{}) catch return false;
    return true;
}

fn writeSchemaMarker(allocator: std.mem.Allocator, dir: []const u8) !void {
    const marker_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir, schema_marker });
    defer allocator.free(marker_path);
    const file = try std.fs.cwd().createFile(marker_path, .{ .truncate = true });
    defer file.close();
    try file.writeAll("ok\n");
}

fn sqlitePath(allocator: std.mem.Allocator) ![]u8 {
    const dir = try requiredEnv(allocator, "JCOMMENT_DATA_DIR");
    defer allocator.free(dir);
    return std.fmt.allocPrint(allocator, "{s}/jcomment.sqlite3", .{dir});
}

fn requiredEnv(allocator: std.mem.Allocator, key: []const u8) ![]u8 {
    const value = try envOr(allocator, key, "");
    if (value.len == 0) {
        allocator.free(value);
        return error.MissingRequiredEnvironment;
    }
    return value;
}

fn cleanupExpiredAuth(allocator: std.mem.Allocator) !void {
    const now = nowMs();
    const sql = try std.fmt.allocPrint(allocator, "delete from sessions where expires_at < {d}; delete from resets where expires_at < {d};", .{ now, now });
    defer allocator.free(sql);
    try sqliteExec(allocator, sql);
}

fn sqliteBin(allocator: std.mem.Allocator) ![]u8 {
    const bin = try envOr(allocator, "JCOMMENT_SQLITE_BIN", "/usr/bin/sqlite3");
    if (bin.len == 0 or bin[0] != '/') {
        allocator.free(bin);
        return error.InvalidSqliteBinary;
    }
    return bin;
}

fn sqliteExec(allocator: std.mem.Allocator, sql: []const u8) !void {
    const sqlite_bin = try sqliteBin(allocator);
    defer allocator.free(sqlite_bin);
    const db_path = try sqlitePath(allocator);
    defer allocator.free(db_path);
    var child = std.process.Child.init(&.{ sqlite_bin, db_path, sql }, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Pipe;
    try child.spawn();
    const stderr = try child.stderr.?.readToEndAlloc(allocator, 64 * 1024);
    defer allocator.free(stderr);
    const term = try child.wait();
    if (term.Exited != 0) {
        std.debug.print("sqlite error: {s}\n", .{stderr});
        return error.SqliteFailed;
    }
}

fn sqliteExecIgnoreError(allocator: std.mem.Allocator, sql: []const u8) !void {
    const sqlite_bin = try sqliteBin(allocator);
    defer allocator.free(sqlite_bin);
    const db_path = try sqlitePath(allocator);
    defer allocator.free(db_path);
    var child = std.process.Child.init(&.{ sqlite_bin, db_path, sql }, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    try child.spawn();
    _ = try child.wait();
}

fn sqliteQuery(allocator: std.mem.Allocator, sql: []const u8) ![]u8 {
    const sqlite_bin = try sqliteBin(allocator);
    defer allocator.free(sqlite_bin);
    const db_path = try sqlitePath(allocator);
    defer allocator.free(db_path);
    var child = std.process.Child.init(&.{ sqlite_bin, "-separator", "\t", db_path, sql }, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;
    try child.spawn();
    const out = try child.stdout.?.readToEndAlloc(allocator, 1024 * 1024);
    errdefer allocator.free(out);
    const stderr = try child.stderr.?.readToEndAlloc(allocator, 64 * 1024);
    defer allocator.free(stderr);
    const term = try child.wait();
    if (term.Exited != 0) {
        std.debug.print("sqlite error: {s}\n", .{stderr});
        return error.SqliteFailed;
    }
    return out;
}

fn sqlText(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    const hex = try std.fmt.allocPrint(allocator, "{}", .{std.fmt.fmtSliceHexLower(value)});
    defer allocator.free(hex);
    return std.fmt.allocPrint(allocator, "cast(X'{s}' as text)", .{hex});
}

fn hexToBytes(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    var out = try allocator.alloc(u8, value.len / 2);
    var i: usize = 0;
    while (i < out.len) : (i += 1) {
        out[i] = try std.fmt.parseInt(u8, value[i * 2 .. i * 2 + 2], 16);
    }
    return out;
}

fn readRequestBody(allocator: std.mem.Allocator) ![]u8 {
    const len_text = try envOr(allocator, "CONTENT_LENGTH", "0");
    defer allocator.free(len_text);
    const requested = std.fmt.parseInt(usize, len_text, 10) catch 0;
    if (requested > max_body) return error.RequestBodyTooLarge;
    const body = try allocator.alloc(u8, requested);
    errdefer allocator.free(body);
    try std.io.getStdIn().reader().readNoEof(body);
    return body;
}

fn jsonField(allocator: std.mem.Allocator, input: []const u8, key: []const u8) ![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, input, .{}) catch return error.InvalidJson;
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |object| object,
        else => return error.InvalidJson,
    };
    const value = object.get(key) orelse return allocator.dupe(u8, "");
    return switch (value) {
        .string => |text| allocator.dupe(u8, text),
        else => allocator.dupe(u8, ""),
    };
}

fn cleanAlloc(allocator: std.mem.Allocator, value: []const u8, fallback: []const u8) ![]u8 {
    return cleanAllocLimit(allocator, value, fallback, std.math.maxInt(usize));
}

fn cleanAllocLimit(allocator: std.mem.Allocator, value: []const u8, fallback: []const u8, limit: usize) ![]u8 {
    const source = if (value.len == 0) fallback else value;
    var out = try allocator.alloc(u8, @min(source.len, limit));
    var n: usize = 0;
    for (source) |c| {
        if (n >= limit) break;
        if (c >= 32 or c == '\n' or c == '\t') {
            out[n] = c;
            n += 1;
        }
    }
    return allocator.realloc(out, n);
}

fn cleanAccountFieldAlloc(allocator: std.mem.Allocator, value: []const u8, fallback: []const u8) !?[]u8 {
    return cleanAccountFieldAllocLimit(allocator, value, fallback, std.math.maxInt(usize));
}

fn cleanAccountFieldAllocLimit(allocator: std.mem.Allocator, value: []const u8, fallback: []const u8, limit: usize) !?[]u8 {
    const source = if (value.len == 0) fallback else value;
    for (source) |c| {
        if (c < 32 or c == '\t' or c == '\n' or c == '\r') return null;
    }
    return try allocator.dupe(u8, source[0..@min(source.len, limit)]);
}

fn nowIso(allocator: std.mem.Allocator) ![]u8 {
    const ts = std.time.timestamp();
    return std.fmt.allocPrint(allocator, "{d}", .{ts});
}

fn nowMs() i64 {
    return std.time.milliTimestamp();
}

fn makeId(allocator: std.mem.Allocator) ![]u8 {
    var random_bytes: [32]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);
    return std.fmt.allocPrint(allocator, "{}", .{std.fmt.fmtSliceHexLower(&random_bytes)});
}

fn tokenDigest(allocator: std.mem.Allocator, token: []const u8) ![]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &digest, .{});
    return std.fmt.allocPrint(allocator, "sha256:{}", .{std.fmt.fmtSliceHexLower(&digest)});
}

fn envInt(allocator: std.mem.Allocator, key: []const u8, fallback: i64) i64 {
    const value = envOr(allocator, key, "") catch return fallback;
    defer allocator.free(value);
    if (value.len == 0) return fallback;
    return std.fmt.parseInt(i64, value, 10) catch fallback;
}

fn rateLimit(allocator: std.mem.Allocator, action: []const u8, site: []const u8, ip: []const u8, fallback_limit: usize) !bool {
    if (!envEnabled(allocator, "JCOMMENT_RATE_LIMIT_ENABLED", true)) return true;
    if (ip.len == 0 and !envEnabled(allocator, "JCOMMENT_RATE_LIMIT_ALLOW_ANONYMOUS_IDENTITY", false)) {
        try jsonError(503, "Service Unavailable", "Server rate limit identity is not configured");
        return false;
    }
    const identity = if (ip.len == 0) "anonymous" else ip;
    const key = try std.fmt.allocPrint(allocator, "{s}:{s}:{s}", .{ action, site, identity });
    defer allocator.free(key);
    const sql_key = try sqlText(allocator, key);
    defer allocator.free(sql_key);
    const window_ms = @max(@as(i64, 1000), envInt(allocator, "JCOMMENT_RATE_LIMIT_WINDOW_MS", 60_000));
    const now = nowMs();
    const reset_at = now + window_ms;
    const limit = @max(@as(usize, 1), fallback_limit);
    const sql = try std.fmt.allocPrint(allocator,
        \\delete from rate_limits where reset_at <= {d};
        \\insert into rate_limits(key, count, reset_at) values({s}, 1, {d})
        \\on conflict(key) do update set
        \\  count = case when reset_at <= {d} then 1 else count + 1 end,
        \\  reset_at = case when reset_at <= {d} then {d} else reset_at end;
        \\select count from rate_limits where key = {s};
    , .{ now, sql_key, reset_at, now, now, reset_at, sql_key });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    const count = std.fmt.parseInt(usize, std.mem.trim(u8, data, "\r\n\t "), 10) catch 0;
    if (count > limit) {
        try jsonError(429, "Too Many Requests", "Too many requests");
        return false;
    }
    return true;
}

fn escapeTsv(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    var out = std.ArrayList(u8).init(allocator);
    for (value) |c| {
        switch (c) {
            '\t' => try out.appendSlice("\\t"),
            '\n' => try out.appendSlice("\\n"),
            '\\' => try out.appendSlice("\\\\"),
            else => try out.append(c),
        }
    }
    return out.toOwnedSlice();
}

fn unescapeTsv(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    var out = std.ArrayList(u8).init(allocator);
    var i: usize = 0;
    while (i < value.len) : (i += 1) {
        if (value[i] == '\\' and i + 1 < value.len) {
            i += 1;
            try out.append(switch (value[i]) {
                'n' => '\n',
                't' => '\t',
                else => value[i],
            });
        } else {
            try out.append(value[i]);
        }
    }
    return out.toOwnedSlice();
}

fn loadComments(allocator: std.mem.Allocator, site: []const u8, thread: []const u8) ![]Comment {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql = try std.fmt.allocPrint(allocator, "select hex(id), hex(parent_id), hex(author), hex(body), hex(created_at), score from comments where site = {s} and thread = {s};", .{ sql_site, sql_thread });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);

    var comments = std.ArrayList(Comment).init(allocator);
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line_raw| {
        if (line_raw.len == 0 or comments.items.len >= max_comments) continue;
        const line = std.mem.trimRight(u8, line_raw, "\r");
        var fields = std.mem.splitScalar(u8, line, '\t');
        const id = fields.next() orelse continue;
        const parent_id = fields.next() orelse continue;
        const author = fields.next() orelse continue;
        const body = fields.next() orelse continue;
        const created_at = fields.next() orelse continue;
        const score_text = fields.next() orelse "0";
        try comments.append(.{
            .id = try hexToBytes(allocator, id),
            .parent_id = try hexToBytes(allocator, parent_id),
            .author = try hexToBytes(allocator, author),
            .body = try hexToBytes(allocator, body),
            .created_at = try hexToBytes(allocator, created_at),
            .score = std.fmt.parseInt(i32, score_text, 10) catch 0,
        });
    }
    return comments.toOwnedSlice();
}

fn freeComments(allocator: std.mem.Allocator, comments: []Comment) void {
    for (comments) |c| {
        allocator.free(c.id);
        allocator.free(c.parent_id);
        allocator.free(c.author);
        allocator.free(c.body);
        allocator.free(c.created_at);
    }
    allocator.free(comments);
}

fn saveComments(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, comments: []Comment) !void {
    var sql = std.ArrayList(u8).init(allocator);
    defer sql.deinit();
    const w = sql.writer();
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    try w.print("begin immediate; delete from comments where site = {s} and thread = {s};", .{ sql_site, sql_thread });
    for (comments) |c| {
        const id = try sqlText(allocator, c.id);
        defer allocator.free(id);
        const parent_id = try sqlText(allocator, c.parent_id);
        defer allocator.free(parent_id);
        const author = try sqlText(allocator, c.author);
        defer allocator.free(author);
        const body = try sqlText(allocator, c.body);
        defer allocator.free(body);
        const created_at = try sqlText(allocator, c.created_at);
        defer allocator.free(created_at);
        try w.print("insert into comments(id, site, thread, parent_id, author, body, created_at, score) values({s}, {s}, {s}, {s}, {s}, {s}, {s}, {d});", .{ id, sql_site, sql_thread, parent_id, author, body, created_at, c.score });
    }
    try w.writeAll("commit;");
    try sqliteExec(allocator, sql.items);
}

fn threadCommentCount(allocator: std.mem.Allocator, site: []const u8, thread: []const u8) !usize {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql = try std.fmt.allocPrint(allocator, "select count(*) from comments where site = {s} and thread = {s};", .{ sql_site, sql_thread });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    return std.fmt.parseInt(usize, std.mem.trim(u8, data, "\r\n\t "), 10) catch 0;
}

fn siteCommentCount(allocator: std.mem.Allocator, site: []const u8) !usize {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql = try std.fmt.allocPrint(allocator, "select count(*) from comments where site = {s};", .{sql_site});
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    return std.fmt.parseInt(usize, std.mem.trim(u8, data, "\r\n\t "), 10) catch 0;
}

fn commentExists(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, id: []const u8) !bool {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql_id = try sqlText(allocator, id);
    defer allocator.free(sql_id);
    const sql = try std.fmt.allocPrint(allocator, "select 1 from comments where site = {s} and thread = {s} and id = {s} limit 1;", .{ sql_site, sql_thread, sql_id });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    return std.mem.trim(u8, data, "\r\n\t ").len > 0;
}

fn insertComment(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, c: Comment) !void {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const id = try sqlText(allocator, c.id);
    defer allocator.free(id);
    const parent_id = try sqlText(allocator, c.parent_id);
    defer allocator.free(parent_id);
    const author = try sqlText(allocator, c.author);
    defer allocator.free(author);
    const body = try sqlText(allocator, c.body);
    defer allocator.free(body);
    const created_at = try sqlText(allocator, c.created_at);
    defer allocator.free(created_at);
    const sql = try std.fmt.allocPrint(allocator, "insert into comments(id, site, thread, parent_id, author, body, created_at, score) values({s}, {s}, {s}, {s}, {s}, {s}, {s}, {d});", .{ id, sql_site, sql_thread, parent_id, author, body, created_at, c.score });
    defer allocator.free(sql);
    try sqliteExec(allocator, sql);
}

fn insertCommentChecked(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, c: Comment) !bool {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const id = try sqlText(allocator, c.id);
    defer allocator.free(id);
    const parent_id = try sqlText(allocator, c.parent_id);
    defer allocator.free(parent_id);
    const author = try sqlText(allocator, c.author);
    defer allocator.free(author);
    const body = try sqlText(allocator, c.body);
    defer allocator.free(body);
    const created_at = try sqlText(allocator, c.created_at);
    defer allocator.free(created_at);
    const sql = try std.fmt.allocPrint(allocator,
        \\begin immediate;
        \\insert into comments(id, site, thread, parent_id, author, body, created_at, score)
        \\select {s}, {s}, {s}, {s}, {s}, {s}, {s}, {d}
        \\where (select count(*) from comments where site = {s}) < {d}
        \\  and (select count(*) from comments where site = {s} and thread = {s}) < {d}
        \\  and ({s} = '' or exists (select 1 from comments where site = {s} and thread = {s} and id = {s}));
        \\select changes();
        \\commit;
    , .{
        id, sql_site, sql_thread, parent_id, author, body, created_at, c.score,
        sql_site, max_site_comments,
        sql_site, sql_thread, max_comments,
        parent_id, sql_site, sql_thread, parent_id,
    });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    const changed = std.fmt.parseInt(usize, std.mem.trim(u8, data, "\r\n\t "), 10) catch 0;
    return changed > 0;
}

fn replyCount(comments: []Comment, id: []const u8) usize {
    var count: usize = 0;
    for (comments) |c| {
        if (std.mem.eql(u8, c.parent_id, id)) count += 1;
    }
    return count;
}

fn printComment(w: anytype, comments: []Comment, c: Comment) !void {
    try w.writeAll("{\"id\":");
    try std.json.stringify(c.id, .{}, w);
    try w.writeAll(",\"parentId\":");
    try std.json.stringify(c.parent_id, .{}, w);
    try w.writeAll(",\"author\":");
    try std.json.stringify(c.author, .{}, w);
    try w.writeAll(",\"body\":");
    try std.json.stringify(c.body, .{}, w);
    try w.writeAll(",\"createdAt\":");
    try std.json.stringify(c.created_at, .{}, w);
    try w.print(",\"score\":{d},\"replyCount\":{d}}}", .{ c.score, replyCount(comments, c.id) });
}

fn newer(_: void, a: Comment, b: Comment) bool {
    return std.mem.order(u8, b.created_at, a.created_at) == .lt;
}

fn older(_: void, a: Comment, b: Comment) bool {
    return std.mem.order(u8, a.created_at, b.created_at) == .lt;
}

fn top(_: void, a: Comment, b: Comment) bool {
    if (a.score != b.score) return a.score > b.score;
    return newer({}, a, b);
}

fn listResponse(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, sort: []const u8) !void {
    const comments = try loadComments(allocator, site, thread);
    defer freeComments(allocator, comments);

    var roots = std.ArrayList(Comment).init(allocator);
    defer roots.deinit();
    for (comments) |c| {
        if (c.parent_id.len == 0) try roots.append(c);
    }
    if (std.mem.eql(u8, sort, "oldest")) {
        std.mem.sort(Comment, roots.items, {}, older);
    } else if (std.mem.eql(u8, sort, "top")) {
        std.mem.sort(Comment, roots.items, {}, top);
    } else {
        std.mem.sort(Comment, roots.items, {}, newer);
    }

    const w = stdout();
    try status(200, "OK");
    try w.writeAll("{\"comments\":[");
    var printed = false;
    for (roots.items) |root| {
        if (printed) try w.writeAll(",");
        try printComment(w, comments, root);
        printed = true;
        var replies_printed: usize = 0;
        for (comments) |reply| {
            if (std.mem.eql(u8, reply.parent_id, root.id)) {
                if (replies_printed >= max_replies_per_root) continue;
                try w.writeAll(",");
                try printComment(w, comments, reply);
                replies_printed += 1;
            }
        }
    }
    try w.print("],\"count\":{d},\"nextCursor\":null,\"sort\":", .{comments.len});
    try std.json.stringify(sort, .{}, w);
    try w.writeAll(",\"capabilities\":");
    try printCapabilities(w);
    try w.writeAll("}");
}

fn printCapabilities(w: anytype) !void {
    const login_enabled = envEnabled(std.heap.page_allocator, "JCOMMENT_LOGIN_ENABLED", true);
    const voting_enabled = envEnabled(std.heap.page_allocator, "JCOMMENT_VOTING_ENABLED", true);
    const localhost_voting = envEnabled(std.heap.page_allocator, "JCOMMENT_LOCALHOST_VOTING_ENABLED", false);
    const reset_enabled = envEnabled(std.heap.page_allocator, "JCOMMENT_PASSWORD_RESET_ENABLED", false);
    const require_login_to_post = envEnabled(std.heap.page_allocator, "JCOMMENT_REQUIRE_LOGIN_TO_POST", false);
    const mode = emailMode(std.heap.page_allocator);
    defer std.heap.page_allocator.free(mode);
    try w.writeAll("{\"voting\":");
    try w.writeAll(if (voting_enabled and (login_enabled or localhost_voting)) "true" else "false");
    try w.writeAll(",\"login\":");
    try w.writeAll(if (login_enabled) "true" else "false");
    try w.writeAll(",\"ipStorage\":false,\"accounts\":{\"email\":");
    try std.json.stringify(mode, .{}, w);
    try w.writeAll(",\"passwordReset\":");
    try w.writeAll(if (reset_enabled and !std.mem.eql(u8, mode, "none")) "true" else "false");
    try w.writeAll("},\"posting\":{\"requireLogin\":");
    try w.writeAll(if (require_login_to_post) "true" else "false");
    try w.writeAll("}}");
}

fn handleAdd(allocator: std.mem.Allocator, thread: []const u8, site: []const u8, sort: []const u8, body: []const u8) !void {
    var logged_in_username: ?[]u8 = null;
    defer if (logged_in_username) |value| allocator.free(value);
    if (envEnabled(allocator, "JCOMMENT_REQUIRE_LOGIN_TO_POST", false)) {
        if (!envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true)) {
            try jsonError(403, "Forbidden", "Posting requires login, but login is disabled for this site");
            return;
        }
        const token = try bearerToken(allocator);
        defer allocator.free(token);
        logged_in_username = try loginTokenUsername(allocator, site, token);
        if (logged_in_username == null) {
            try jsonError(401, "Unauthorized", "Login is required to post comments");
            return;
        }
    }

    const raw_author = try jsonField(allocator, body, "author");
    defer allocator.free(raw_author);
    const raw_body = try jsonField(allocator, body, "body");
    defer allocator.free(raw_body);
    const raw_parent = try jsonField(allocator, body, "parentId");
    defer allocator.free(raw_parent);

    if (raw_body.len == 0) {
        try jsonError(400, "Bad Request", "Comment body is required");
        return;
    }

    const parent_id = try cleanAllocLimit(allocator, raw_parent, "", 120);
    var parent_transferred = false;
    defer if (!parent_transferred) allocator.free(parent_id);
    const cleaned_body = try cleanAllocLimit(allocator, raw_body, "", max_comment_body);
    defer allocator.free(cleaned_body);
    if (cleaned_body.len == 0) {
        try jsonError(400, "Bad Request", "Comment body is required");
        return;
    }

    const comment = Comment{
        .id = try makeId(allocator),
        .parent_id = parent_id,
        .author = if (logged_in_username) |username| try cleanAllocLimit(allocator, username, "Anonymous", max_author) else try cleanAllocLimit(allocator, raw_author, "Anonymous", max_author),
        .body = try allocator.dupe(u8, cleaned_body),
        .created_at = try nowIso(allocator),
        .score = 0,
    };
    defer {
        allocator.free(comment.id);
        allocator.free(comment.parent_id);
        allocator.free(comment.author);
        allocator.free(comment.body);
        allocator.free(comment.created_at);
    }
    parent_transferred = true;
    if (!try insertCommentChecked(allocator, site, thread, comment)) {
        if (parent_id.len > 0 and !try commentExists(allocator, site, thread, parent_id)) {
            try jsonError(404, "Not Found", "Parent comment was not found");
            return;
        }
        if (try siteCommentCount(allocator, site) >= max_site_comments) {
            try jsonError(507, "Insufficient Storage", "Comment store is full for this site");
            return;
        }
        if (try threadCommentCount(allocator, site, thread) >= max_comments) {
            try jsonError(507, "Insufficient Storage", "Comment store is full");
            return;
        }
        try jsonError(409, "Conflict", "Comment could not be created");
        return;
    }
    try listResponse(allocator, site, thread, sort);
}

fn emailMode(allocator: std.mem.Allocator) []u8 {
    return envOr(allocator, "JCOMMENT_EMAIL_MODE", "none") catch unreachable;
}

fn validEmail(value: []const u8) bool {
    if (value.len == 0 or value.len > max_email) return false;
    const at = std.mem.indexOfScalar(u8, value, '@') orelse return false;
    if (at == 0 or at + 1 >= value.len) return false;
    const domain = value[at + 1 ..];
    if (std.mem.indexOfScalar(u8, domain, '.') == null) return false;
    for (value) |c| {
        if (std.ascii.isWhitespace(c)) return false;
    }
    return true;
}

fn reservedUsername(allocator: std.mem.Allocator, username: []const u8) !bool {
    const configured = try envOr(allocator, "JCOMMENT_RESERVED_USERNAMES", "admin,administrator,moderator,mod,staff,system,anonymous,jcomment");
    defer allocator.free(configured);
    var items = std.mem.splitScalar(u8, configured, ',');
    while (items.next()) |item_raw| {
        const item = std.mem.trim(u8, item_raw, " \t\r\n");
        if (item.len > 0 and std.ascii.eqlIgnoreCase(item, username)) return true;
    }
    return false;
}

fn findAccountLine(allocator: std.mem.Allocator, site: []const u8, username: []const u8) !?[]u8 {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_username = try sqlText(allocator, username);
    defer allocator.free(sql_username);
    const sql = try std.fmt.allocPrint(allocator, "select hex(site), hex(username), hex(email), hex(password_hash), hex(created_at) from accounts where site = {s} and lower(username) = lower({s}) limit 1;", .{ sql_site, sql_username });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    const line = std.mem.trim(u8, data, "\r\n");
    if (line.len == 0) return null;
    var fields = std.mem.splitScalar(u8, line, '\t');
    const saved_site = try hexToBytes(allocator, fields.next() orelse return null);
    defer allocator.free(saved_site);
    const saved_username = try hexToBytes(allocator, fields.next() orelse return null);
    defer allocator.free(saved_username);
    const saved_email = try hexToBytes(allocator, fields.next() orelse "");
    defer allocator.free(saved_email);
    const saved_hash = try hexToBytes(allocator, fields.next() orelse return null);
    defer allocator.free(saved_hash);
    const saved_created = try hexToBytes(allocator, fields.next() orelse "");
    defer allocator.free(saved_created);
    const account_line = try std.fmt.allocPrint(allocator, "{s}\t{s}\t{s}\t{s}\t{s}", .{ saved_site, saved_username, saved_email, saved_hash, saved_created });
    return account_line;
}

fn accountField(line: []const u8, index: usize) []const u8 {
    var fields = std.mem.splitScalar(u8, line, '\t');
    var i: usize = 0;
    while (fields.next()) |field| : (i += 1) {
        if (i == index) return field;
    }
    return "";
}

fn hashPassword(allocator: std.mem.Allocator, password: []const u8) ![]u8 {
    var out: [256]u8 = undefined;
    const hash = try std.crypto.pwhash.argon2.strHash(password, .{
        .allocator = allocator,
        .params = .interactive_2id,
        .mode = .argon2id,
    }, &out);
    return allocator.dupe(u8, hash);
}

fn verifyPassword(allocator: std.mem.Allocator, hash: []const u8, password: []const u8) bool {
    std.crypto.pwhash.argon2.strVerify(hash, password, .{ .allocator = allocator }) catch return false;
    return true;
}

fn writeSession(allocator: std.mem.Allocator, site: []const u8, username: []const u8) ![]u8 {
    const token = try makeId(allocator);
    errdefer allocator.free(token);
    const token_digest = try tokenDigest(allocator, token);
    defer allocator.free(token_digest);
    const sql_token = try sqlText(allocator, token_digest);
    defer allocator.free(sql_token);
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_username = try sqlText(allocator, username);
    defer allocator.free(sql_username);
    const ttl_ms = @max(@as(i64, 1), envInt(allocator, "JCOMMENT_SESSION_TTL_MS", 30 * 24 * 60 * 60 * 1000));
    const expires_at = nowMs() + ttl_ms;
    const sql = try std.fmt.allocPrint(allocator, "insert into sessions(token, site, username, expires_at) values({s}, {s}, {s}, {d});", .{ sql_token, sql_site, sql_username, expires_at });
    defer allocator.free(sql);
    try sqliteExec(allocator, sql);
    return token;
}

fn validCookieName(value: []const u8) bool {
    if (value.len == 0) return false;
    for (value) |c| {
        if (!(std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", c) != null)) return false;
    }
    return true;
}

fn sessionCookie(allocator: std.mem.Allocator, token: []const u8) ![]u8 {
    const raw_name = try envOr(allocator, "JCOMMENT_SESSION_COOKIE_NAME", "jcomment_session");
    defer allocator.free(raw_name);
    const name = if (validCookieName(raw_name)) raw_name else "jcomment_session";
    const ttl_ms = @max(@as(i64, 1), envInt(allocator, "JCOMMENT_SESSION_TTL_MS", 30 * 24 * 60 * 60 * 1000));
    const max_age = @max(@as(i64, 1), @divFloor(ttl_ms, 1000));
    const raw_same_site = try envOr(allocator, "JCOMMENT_SESSION_COOKIE_SAMESITE", "Lax");
    defer allocator.free(raw_same_site);
    const same_site = if (std.mem.eql(u8, raw_same_site, "Strict") or std.mem.eql(u8, raw_same_site, "None")) raw_same_site else "Lax";
    const secure = envEnabled(allocator, "JCOMMENT_SESSION_COOKIE_SECURE", true);
    return std.fmt.allocPrint(allocator, "{s}={s}; HttpOnly; Path=/; Max-Age={d}; SameSite={s}{s}", .{
        name,
        token,
        max_age,
        same_site,
        if (secure) "; Secure" else "",
    });
}

fn accountResponse(allocator: std.mem.Allocator, site: []const u8, username: []const u8) !void {
    const token = try writeSession(allocator, site, username);
    defer allocator.free(token);
    const created = try nowIso(allocator);
    defer allocator.free(created);
    const cookie_enabled = envEnabled(allocator, "JCOMMENT_SESSION_COOKIE_ENABLED", false);
    const expose_token = envEnabled(allocator, "JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN", false);
    const cookie = if (cookie_enabled) try sessionCookie(allocator, token) else null;
    defer if (cookie) |value| allocator.free(value);

    delayAuthResponse();
    const w = stdout();
    try statusWithCookie(201, "Created", cookie);
    try w.writeAll("{\"user\":{\"username\":");
    try std.json.stringify(username, .{}, w);
    try w.writeAll(",\"name\":");
    try std.json.stringify(username, .{}, w);
    try w.writeAll(",\"createdAt\":");
    try std.json.stringify(created, .{}, w);
    try w.writeAll("}");
    if (!cookie_enabled or expose_token) {
        try w.writeAll(",\"token\":");
        try std.json.stringify(token, .{}, w);
    }
    try w.writeAll("}");
}

fn handleSignup(allocator: std.mem.Allocator, site: []const u8, body: []const u8) !void {
    const raw_username = try jsonField(allocator, body, "username");
    defer allocator.free(raw_username);
    const raw_email = try jsonField(allocator, body, "email");
    defer allocator.free(raw_email);
    const password = try jsonField(allocator, body, "password");
    defer allocator.free(password);
    const username = (try cleanAccountFieldAllocLimit(allocator, raw_username, "", max_username)) orelse return jsonError(400, "Bad Request", "Username contains invalid characters");
    defer allocator.free(username);
    const email = (try cleanAccountFieldAllocLimit(allocator, raw_email, "", max_email)) orelse return jsonError(400, "Bad Request", "Email contains invalid characters");
	    defer allocator.free(email);
	    if (username.len == 0) return jsonError(400, "Bad Request", "Username is required");
	    if (try reservedUsername(allocator, username)) return jsonError(400, "Bad Request", "Username is reserved for this site");
	    if (password.len < 8) return jsonError(400, "Bad Request", "Password must be at least 8 characters");
    if (password.len > 256) return jsonError(400, "Bad Request", "Password must be at most 256 characters");
    const mode = emailMode(allocator);
    defer allocator.free(mode);
    if (std.mem.eql(u8, mode, "required") and !validEmail(email)) return jsonError(400, "Bad Request", "Email is required");
    if (!std.mem.eql(u8, mode, "none") and email.len > 0 and !validEmail(email)) return jsonError(400, "Bad Request", "Email is invalid");
	    if (std.mem.eql(u8, mode, "none") and email.len != 0) return jsonError(400, "Bad Request", "Email is disabled for this site");
	    if (try findAccountLine(allocator, site, username)) |existing| {
	        allocator.free(existing);
	        const dummy_hash = try hashPassword(allocator, password);
	        allocator.free(dummy_hash);
	        return duplicateSignupResponse(allocator);
	    }

    const hash = try hashPassword(allocator, password);
    defer allocator.free(hash);
    const created = try nowIso(allocator);
    defer allocator.free(created);
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_username = try sqlText(allocator, username);
    defer allocator.free(sql_username);
    const sql_email = try sqlText(allocator, email);
    defer allocator.free(sql_email);
    const sql_hash = try sqlText(allocator, hash);
    defer allocator.free(sql_hash);
    const sql_created = try sqlText(allocator, created);
    defer allocator.free(sql_created);
    const sql = try std.fmt.allocPrint(allocator, "insert into accounts(site, username, email, password_hash, created_at) values({s}, {s}, {s}, {s}, {s});", .{ sql_site, sql_username, sql_email, sql_hash, sql_created });
    defer allocator.free(sql);
    sqliteExec(allocator, sql) catch {
        return duplicateSignupResponse(allocator);
    };
    if (!envEnabled(allocator, "JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE", false)) return duplicateSignupResponse(allocator);
    try accountResponse(allocator, site, username);
}

fn duplicateSignupResponse(allocator: std.mem.Allocator) !void {
    delayAuthResponse();
    if (envEnabled(allocator, "JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE", false)) {
        return jsonError(409, "Conflict", "Account already exists for this site");
    }
    const w = stdout();
    try status(202, "Accepted");
    try w.writeAll("{\"ok\":true}");
}

fn handleLogin(allocator: std.mem.Allocator, site: []const u8, body: []const u8) !void {
    const raw_username = try jsonField(allocator, body, "username");
    defer allocator.free(raw_username);
    const password = try jsonField(allocator, body, "password");
    defer allocator.free(password);
    if (password.len > 256) return jsonError(401, "Unauthorized", "Invalid username or password");
    const username = (try cleanAccountFieldAllocLimit(allocator, raw_username, "", max_username)) orelse return jsonError(401, "Unauthorized", "Invalid username or password");
    defer allocator.free(username);
    const line = (try findAccountLine(allocator, site, username)) orelse {
        const hash = try hashPassword(allocator, password);
        allocator.free(hash);
        return jsonError(401, "Unauthorized", "Invalid username or password");
    };
    defer allocator.free(line);
    const hash = accountField(line, 3);
    if (!verifyPassword(allocator, hash, password)) return jsonError(401, "Unauthorized", "Invalid username or password");
    try accountResponse(allocator, site, username);
}

fn handleResetRequest(allocator: std.mem.Allocator, site: []const u8, body: []const u8) !void {
    if (!envEnabled(allocator, "JCOMMENT_PASSWORD_RESET_ENABLED", false)) return jsonError(403, "Forbidden", "Password reset is disabled for this site");
    const mode = emailMode(allocator);
    defer allocator.free(mode);
    if (std.mem.eql(u8, mode, "none")) return jsonError(403, "Forbidden", "Password reset requires email support");
    const raw_username = try jsonField(allocator, body, "username");
    defer allocator.free(raw_username);
    const raw_email = try jsonField(allocator, body, "email");
    defer allocator.free(raw_email);
	    const username = (try cleanAccountFieldAllocLimit(allocator, raw_username, "", max_username)) orelse {
	        try resetDummyWork(allocator);
	        return resetRequestOk();
	    };
	    defer allocator.free(username);
	    const email = (try cleanAccountFieldAllocLimit(allocator, raw_email, "", max_email)) orelse {
	        try resetDummyWork(allocator);
	        return resetRequestOk();
	    };
	    defer allocator.free(email);
	    if (!validEmail(email)) {
	        try resetDummyWork(allocator);
	        return resetRequestOk();
	    }
    const line_opt = try findAccountLine(allocator, site, username);
    if (line_opt) |line| {
        defer allocator.free(line);
        if (std.mem.eql(u8, accountField(line, 2), email)) {
	            if (try resetTokenPending(allocator, site, username)) {
	                try resetDummyWork(allocator);
	                return resetRequestOk();
	            }
            const token = try makeId(allocator);
            defer allocator.free(token);
            const sql_site = try sqlText(allocator, site);
            defer allocator.free(sql_site);
            const sql_username = try sqlText(allocator, username);
            defer allocator.free(sql_username);
            const token_digest = try tokenDigest(allocator, token);
            defer allocator.free(token_digest);
            const sql_token = try sqlText(allocator, token_digest);
            defer allocator.free(sql_token);
            const ttl_ms = @max(@as(i64, 1), envInt(allocator, "JCOMMENT_PASSWORD_RESET_TTL_MS", 3600_000));
            const expires_at = nowMs() + ttl_ms;
            const sql = try std.fmt.allocPrint(allocator, "insert into resets(site, username, token, expires_at) values({s}, {s}, {s}, {d});", .{ sql_site, sql_username, sql_token, expires_at });
            defer allocator.free(sql);
            try sqliteExec(allocator, sql);
            deliverResetToken(allocator, site, username, email, token) catch |err| {
                const cleanup = try std.fmt.allocPrint(allocator, "delete from resets where site = {s} and token = {s};", .{ sql_site, sql_token });
                defer allocator.free(cleanup);
                sqliteExec(allocator, cleanup) catch {};
                return err;
            };
	        }
	    } else {
	        try resetDummyWork(allocator);
	    }
    try resetRequestOk();
}

fn resetRequestOk() !void {
    delayAuthResponse();
    const w = stdout();
    try status(201, "Created");
    try w.writeAll("{\"ok\":true}");
}

fn resetDummyWork(allocator: std.mem.Allocator) !void {
    const token = try makeId(allocator);
    defer allocator.free(token);
    const digest = try tokenDigest(allocator, token);
    allocator.free(digest);
}

fn delayAuthResponse() void {
    std.time.sleep(200 * std.time.ns_per_ms);
}

fn deliverResetToken(allocator: std.mem.Allocator, site: []const u8, username: []const u8, email: []const u8, token: []const u8) !void {
    const command = try envOr(allocator, "JCOMMENT_PASSWORD_RESET_COMMAND", "");
    defer allocator.free(command);
    if (command.len == 0 or command[0] != '/') return error.InvalidResetCommand;
    var env_map = std.process.EnvMap.init(allocator);
    defer env_map.deinit();
    try env_map.put("JCOMMENT_RESET_SITE", site);
    try env_map.put("JCOMMENT_RESET_USERNAME", username);
    try env_map.put("JCOMMENT_RESET_EMAIL", email);
    var child = std.process.Child.init(&.{command}, allocator);
    child.env_map = &env_map;
    child.stdin_behavior = .Pipe;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Pipe;
    try child.spawn();
    try child.stdin.?.writeAll(token);
    try child.stdin.?.writeAll("\n");
    child.stdin.?.close();
    child.stdin = null;
    const stderr = try child.stderr.?.readToEndAlloc(allocator, 64 * 1024);
    defer allocator.free(stderr);
    const term = try child.wait();
    if (term.Exited != 0) {
        std.debug.print("password reset command failed: {s}\n", .{stderr});
        return error.ResetCommandFailed;
    }
}

fn resetTokenPending(allocator: std.mem.Allocator, site: []const u8, username: []const u8) !bool {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_username = try sqlText(allocator, username);
    defer allocator.free(sql_username);
    const sql = try std.fmt.allocPrint(allocator, "select 1 from resets where site = {s} and username = {s} and expires_at >= {d} limit 1;", .{ sql_site, sql_username, nowMs() });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    return std.mem.trim(u8, data, "\r\n\t ").len > 0;
}

fn handleResetConfirm(allocator: std.mem.Allocator, site: []const u8, body: []const u8) !void {
    if (!envEnabled(allocator, "JCOMMENT_PASSWORD_RESET_ENABLED", false)) return jsonError(403, "Forbidden", "Password reset is disabled for this site");
    const raw_token = try jsonField(allocator, body, "token");
    defer allocator.free(raw_token);
    const token = try cleanAllocLimit(allocator, raw_token, "", max_token);
    defer allocator.free(token);
    const password = try jsonField(allocator, body, "password");
    defer allocator.free(password);
    if (password.len < 8) return jsonError(400, "Bad Request", "Password must be at least 8 characters");
    if (password.len > 256) return jsonError(400, "Bad Request", "Password must be at most 256 characters");
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const token_digest = try tokenDigest(allocator, token);
    defer allocator.free(token_digest);
    const sql_token = try sqlText(allocator, token_digest);
    defer allocator.free(sql_token);
    const query = try std.fmt.allocPrint(allocator, "select hex(username) from resets where site = {s} and token = {s} and expires_at >= {d} limit 1;", .{ sql_site, sql_token, nowMs() });
    defer allocator.free(query);
    const reset_data = try sqliteQuery(allocator, query);
    defer allocator.free(reset_data);
    const username_hex = std.mem.trim(u8, reset_data, "\r\n");
    if (username_hex.len == 0) return jsonError(400, "Bad Request", "Invalid or expired reset token");
    const found_username = try hexToBytes(allocator, username_hex);
    defer allocator.free(found_username);
    const new_hash = try hashPassword(allocator, password);
    defer allocator.free(new_hash);
    const sql_username = try sqlText(allocator, found_username);
    defer allocator.free(sql_username);
    const sql_hash = try sqlText(allocator, new_hash);
    defer allocator.free(sql_hash);
    const update = try std.fmt.allocPrint(allocator, "begin immediate; update accounts set password_hash = {s} where site = {s} and username = {s}; delete from resets where site = {s} and username = {s}; delete from sessions where site = {s} and username = {s}; commit;", .{ sql_hash, sql_site, sql_username, sql_site, sql_username, sql_site, sql_username });
    defer allocator.free(update);
    try sqliteExec(allocator, update);
    const w = stdout();
    try status(201, "Created");
    try w.writeAll("{\"ok\":true}");
}

fn bearerToken(allocator: std.mem.Allocator) ![]u8 {
    const auth = try envOr(allocator, "HTTP_AUTHORIZATION", "");
    defer allocator.free(auth);
    if (std.mem.startsWith(u8, auth, "Bearer ")) return allocator.dupe(u8, auth[7..]);
    if (!envEnabled(allocator, "JCOMMENT_SESSION_COOKIE_ENABLED", false)) return allocator.dupe(u8, "");
    const raw_name = try envOr(allocator, "JCOMMENT_SESSION_COOKIE_NAME", "jcomment_session");
    defer allocator.free(raw_name);
    const name = if (validCookieName(raw_name)) raw_name else "jcomment_session";
    const cookie = try envOr(allocator, "HTTP_COOKIE", "");
    defer allocator.free(cookie);
    var parts = std.mem.splitScalar(u8, cookie, ';');
    while (parts.next()) |part_raw| {
        const part = std.mem.trim(u8, part_raw, " ");
        const eq = std.mem.indexOfScalar(u8, part, '=') orelse continue;
        if (std.mem.eql(u8, part[0..eq], name)) return allocator.dupe(u8, part[eq + 1 ..]);
    }
    return allocator.dupe(u8, "");
}

fn hasSessionCookie(allocator: std.mem.Allocator) !bool {
    if (!envEnabled(allocator, "JCOMMENT_SESSION_COOKIE_ENABLED", false)) return false;
    const raw_name = try envOr(allocator, "JCOMMENT_SESSION_COOKIE_NAME", "jcomment_session");
    defer allocator.free(raw_name);
    const name = if (validCookieName(raw_name)) raw_name else "jcomment_session";
    const cookie = try envOr(allocator, "HTTP_COOKIE", "");
    defer allocator.free(cookie);
    var parts = std.mem.splitScalar(u8, cookie, ';');
    while (parts.next()) |part_raw| {
        const part = std.mem.trim(u8, part_raw, " ");
        const eq = std.mem.indexOfScalar(u8, part, '=') orelse continue;
        if (std.mem.eql(u8, part[0..eq], name) and eq + 1 < part.len) return true;
    }
    return false;
}

fn loginTokenValid(allocator: std.mem.Allocator, site: []const u8, token: []const u8) !bool {
    const username = try loginTokenUsername(allocator, site, token);
    if (username) |value| {
        allocator.free(value);
        return true;
    }
    return false;
}

fn loginTokenUsername(allocator: std.mem.Allocator, site: []const u8, token: []const u8) !?[]u8 {
    if (token.len == 0) return null;
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const token_digest = try tokenDigest(allocator, token);
    defer allocator.free(token_digest);
    const sql_token = try sqlText(allocator, token_digest);
    defer allocator.free(sql_token);
    const sql = try std.fmt.allocPrint(allocator, "select hex(username) from sessions where token = {s} and site = {s} and expires_at >= {d} limit 1;", .{ sql_token, sql_site, nowMs() });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    const username_hex = std.mem.trim(u8, data, "\r\n\t ");
    if (username_hex.len == 0) {
        const cleanup = try std.fmt.allocPrint(allocator, "delete from sessions where token = {s};", .{sql_token});
        defer allocator.free(cleanup);
        try sqliteExec(allocator, cleanup);
        return null;
    }
    return try hexToBytes(allocator, username_hex);
}

fn clientIp(allocator: std.mem.Allocator) ![]u8 {
    const remote = try envOr(allocator, "REMOTE_ADDR", "");
    errdefer allocator.free(remote);
    if (envEnabled(allocator, "JCOMMENT_TRUST_PROXY_HEADERS", false) and isLocalhost(remote)) {
        if (try trustedProxyIp(allocator)) |value| {
            allocator.free(remote);
            return value;
        }
    }
    if (remote.len > 0) {
        return remote;
    }
    allocator.free(remote);
    return allocator.dupe(u8, "");
}

fn isLocalhost(ip: []const u8) bool {
    return std.mem.eql(u8, ip, "localhost") or std.mem.eql(u8, ip, "::1") or std.mem.startsWith(u8, ip, "127.");
}

fn trustedProxyIp(allocator: std.mem.Allocator) !?[]u8 {
    const selected = try envOr(allocator, "JCOMMENT_TRUST_PROXY_HEADER", "");
    defer allocator.free(selected);
    if (selected.len == 0) return null;
    const env_name = if (std.ascii.eqlIgnoreCase(selected, "cf-connecting-ip"))
        "HTTP_CF_CONNECTING_IP"
    else if (std.ascii.eqlIgnoreCase(selected, "x-real-ip"))
        "HTTP_X_REAL_IP"
    else if (std.ascii.eqlIgnoreCase(selected, "x-forwarded-for"))
        "HTTP_X_FORWARDED_FOR"
    else
        return null;
    const raw = try envOr(allocator, env_name, "");
    defer allocator.free(raw);
    const first = if (std.mem.indexOfScalar(u8, raw, ',')) |comma| raw[0..comma] else raw;
    const trimmed = std.mem.trim(u8, first, " \t");
    if (!validIpLiteral(trimmed)) return null;
    return try allocator.dupe(u8, trimmed);
}

fn validIpLiteral(value: []const u8) bool {
    return validIpv4(value) or validIpv6(value);
}

fn validIpv4(value: []const u8) bool {
    var parts = std.mem.splitScalar(u8, value, '.');
    var count: usize = 0;
    while (parts.next()) |part| {
        if (part.len == 0 or part.len > 3) return false;
        _ = std.fmt.parseInt(u8, part, 10) catch return false;
        count += 1;
    }
    return count == 4;
}

fn validIpv6(value: []const u8) bool {
    if (value.len < 2 or std.mem.indexOfScalar(u8, value, ':') == null) return false;
    for (value) |c| {
        if (!(std.ascii.isHex(c) or c == ':' or c == '.')) return false;
    }
    _ = std.net.Address.parseIp6(value, 0) catch return false;
    return true;
}

fn voteSeen(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, id: []const u8, identity: []const u8, max_votes: usize) !bool {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql_id = try sqlText(allocator, id);
    defer allocator.free(sql_id);
    const sql_identity = try sqlText(allocator, identity);
    defer allocator.free(sql_identity);
    const sql = try std.fmt.allocPrint(allocator, "select count(*) from votes where site = {s} and thread = {s} and comment_id = {s} and identity = {s};", .{ sql_site, sql_thread, sql_id, sql_identity });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    const seen = std.fmt.parseInt(usize, std.mem.trim(u8, data, "\r\n\t "), 10) catch 0;
    return seen >= max_votes;
}

fn rememberVote(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, id: []const u8, identity: []const u8, slot: usize) !void {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql_id = try sqlText(allocator, id);
    defer allocator.free(sql_id);
    const sql_identity = try sqlText(allocator, identity);
    defer allocator.free(sql_identity);
    const sql = try std.fmt.allocPrint(allocator, "insert into votes(site, thread, comment_id, identity, vote_slot) values({s}, {s}, {s}, {s}, {d});", .{ sql_site, sql_thread, sql_id, sql_identity, slot });
    defer allocator.free(sql);
    try sqliteExec(allocator, sql);
}

fn rememberVoteAndIncrement(allocator: std.mem.Allocator, site: []const u8, thread: []const u8, id: []const u8, identity: []const u8, slot: usize) !void {
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql_id = try sqlText(allocator, id);
    defer allocator.free(sql_id);
    const sql_identity = try sqlText(allocator, identity);
    defer allocator.free(sql_identity);
    const sql = try std.fmt.allocPrint(allocator,
        \\begin immediate;
        \\insert into votes(site, thread, comment_id, identity, vote_slot) values({s}, {s}, {s}, {s}, {d});
        \\update comments set score = min(999999, score + 1) where site = {s} and thread = {s} and id = {s};
        \\commit;
    , .{ sql_site, sql_thread, sql_id, sql_identity, slot, sql_site, sql_thread, sql_id });
    defer allocator.free(sql);
    try sqliteExec(allocator, sql);
}

fn handleVote(allocator: std.mem.Allocator, thread: []const u8, site: []const u8, sort: []const u8, body: []const u8) !void {
    if (!envEnabled(allocator, "JCOMMENT_VOTING_ENABLED", true)) {
        try jsonError(403, "Forbidden", "Voting is disabled for this site");
        return;
    }

	    const id = try jsonField(allocator, body, "id");
	    defer allocator.free(id);
	    const action = try jsonField(allocator, body, "action");
	    defer allocator.free(action);
	    if (!std.mem.eql(u8, action, "upvote")) {
	        try jsonError(400, "Bad Request", "Unsupported vote action");
	        return;
	    }
	    if (!try commentExists(allocator, site, thread, id)) {
        try jsonError(404, "Not Found", "Comment was not found");
        return;
    }

    const max_text = try envOr(allocator, "JCOMMENT_MAX_VOTES_PER_IDENTITY", "1");
    defer allocator.free(max_text);
    const max_votes = @max(@as(usize, 1), std.fmt.parseInt(usize, max_text, 10) catch 1);

    const login_enabled = envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true);
    const token = try bearerToken(allocator);
    defer allocator.free(token);
    const identity = blk: {
        if (login_enabled) {
            if (try loginTokenUsername(allocator, site, token)) |username| {
                defer allocator.free(username);
                break :blk try std.fmt.allocPrint(allocator, "login:{s}", .{username});
            }
        }
        const ip = try clientIp(allocator);
        defer allocator.free(ip);
        if (envEnabled(allocator, "JCOMMENT_LOCALHOST_VOTING_ENABLED", false) and isLocalhost(ip)) {
            break :blk try std.fmt.allocPrint(allocator, "localhost:{s}", .{ip});
        }
        if (!login_enabled) {
            try jsonError(403, "Forbidden", "Voting is unavailable from this network");
            return;
        }
        try jsonError(401, "Unauthorized", "Login is required to vote from this network");
        return;
    };
    defer allocator.free(identity);

    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_id = try sqlText(allocator, id);
    defer allocator.free(sql_id);
    const sql_identity = try sqlText(allocator, identity);
    defer allocator.free(sql_identity);
    const count_sql = try std.fmt.allocPrint(allocator, "select count(*) from votes where site = {s} and thread = {s} and comment_id = {s} and identity = {s};", .{ sql_site, sql_thread, sql_id, sql_identity });
    defer allocator.free(count_sql);
    const count_data = try sqliteQuery(allocator, count_sql);
    defer allocator.free(count_data);
    const vote_count = std.fmt.parseInt(usize, std.mem.trim(u8, count_data, "\r\n\t "), 10) catch 0;
    if (vote_count >= max_votes) {
        try jsonError(429, "Too Many Requests", "Vote limit reached for this identity");
        return;
    }
    rememberVoteAndIncrement(allocator, site, thread, id, identity, vote_count) catch {
        try jsonError(429, "Too Many Requests", "Vote limit reached for this identity");
        return;
    };
    try listResponse(allocator, site, thread, sort);
}
