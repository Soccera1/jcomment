const std = @import("std");

const max_body = 8192;
const max_comments = 512;

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

    try ensureDataDir(allocator);

    const method = try envOr(allocator, "REQUEST_METHOD", "");
    defer allocator.free(method);
    const path = try envOr(allocator, "PATH_INFO", "");
    defer allocator.free(path);
    const query = try envOr(allocator, "QUERY_STRING", "");
    defer allocator.free(query);

    const thread = try queryParam(allocator, query, "thread", "default");
    defer allocator.free(thread);
    sanitizeThread(thread);

    const server_name = try envOr(allocator, "SERVER_NAME", "default");
    defer allocator.free(server_name);
    const site = try queryParam(allocator, query, "site", server_name);
    defer allocator.free(site);
    const sort = try queryParam(allocator, query, "sort", "newest");
    defer allocator.free(sort);

    if (!try validateConfig(allocator)) return;

    if (std.mem.eql(u8, method, "OPTIONS")) {
        try status(204, "No Content");
        return;
    }
    if (std.mem.eql(u8, method, "GET")) {
        try listResponse(allocator, thread, sort);
        return;
    }

    const body = try readRequestBody(allocator);
    defer allocator.free(body);

    if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/signup")) {
        if (!envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true)) {
            try jsonError(403, "Forbidden", "Login is disabled for this site");
            return;
        }
        try handleSignup(allocator, site, body);
    } else if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/login")) {
        if (!envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true)) {
            try jsonError(403, "Forbidden", "Login is disabled for this site");
            return;
        }
        try handleLogin(allocator, site, body);
    } else if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/reset/request")) {
        try handleResetRequest(allocator, site, body);
    } else if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/reset/confirm")) {
        try handleResetConfirm(allocator, site, body);
    } else if (std.mem.eql(u8, method, "POST")) {
        try handleAdd(allocator, thread, site, sort, body);
    } else if (std.mem.eql(u8, method, "PATCH")) {
        try handleVote(allocator, thread, site, sort, body);
    } else {
        try jsonError(405, "Method Not Allowed", "Method not allowed");
    }
}

fn stdout() std.fs.File.Writer {
    return std.io.getStdOut().writer();
}

fn status(code: u16, message: []const u8) !void {
    const w = stdout();
    try w.print("Status: {d} {s}\r\n", .{ code, message });
    try w.writeAll("Content-Type: application/json; charset=utf-8\r\n");
    try w.writeAll("Access-Control-Allow-Origin: *\r\n");
    try w.writeAll("Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS\r\n");
    try w.writeAll("Access-Control-Allow-Headers: authorization, content-type\r\n\r\n");
}

fn jsonError(code: u16, message: []const u8, err: []const u8) !void {
    const w = stdout();
    try status(code, message);
    try w.writeAll("{\"error\":");
    try std.json.stringify(err, .{}, w);
    try w.writeAll("}");
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
    const dir = try envOr(allocator, "JCOMMENT_DATA_DIR", "/tmp/jcomment");
    defer allocator.free(dir);
    try std.fs.cwd().makePath(dir);
    try sqliteExec(allocator,
        \\create table if not exists comments(id text primary key, thread text not null, parent_id text not null, author text not null, body text not null, created_at text not null, score integer not null default 0);
        \\create index if not exists comments_thread_idx on comments(thread, created_at);
        \\create table if not exists votes(thread text not null, comment_id text not null, identity text not null);
        \\create index if not exists votes_identity_idx on votes(thread, comment_id, identity);
        \\create table if not exists accounts(site text not null, username text not null, email text not null, password_hash text not null, created_at text not null, unique(site, username));
        \\create table if not exists sessions(token text primary key, site text not null, username text not null);
        \\create table if not exists resets(site text not null, username text not null, token text not null);
    );
}

fn sqlitePath(allocator: std.mem.Allocator) ![]u8 {
    const dir = try envOr(allocator, "JCOMMENT_DATA_DIR", "/tmp/jcomment");
    defer allocator.free(dir);
    return std.fmt.allocPrint(allocator, "{s}/jcomment.sqlite3", .{dir});
}

fn sqliteExec(allocator: std.mem.Allocator, sql: []const u8) !void {
    const db_path = try sqlitePath(allocator);
    defer allocator.free(db_path);
    var child = std.process.Child.init(&.{ "sqlite3", db_path, sql }, allocator);
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

fn sqliteQuery(allocator: std.mem.Allocator, sql: []const u8) ![]u8 {
    const db_path = try sqlitePath(allocator);
    defer allocator.free(db_path);
    var child = std.process.Child.init(&.{ "sqlite3", "-separator", "\t", db_path, sql }, allocator);
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
    const limit = @min(requested, max_body);
    const body = try allocator.alloc(u8, limit);
    errdefer allocator.free(body);
    try std.io.getStdIn().reader().readNoEof(body);
    return body;
}

fn jsonField(allocator: std.mem.Allocator, input: []const u8, key: []const u8) ![]u8 {
    const needle = try std.fmt.allocPrint(allocator, "\"{s}\"", .{key});
    defer allocator.free(needle);
    const start = std.mem.indexOf(u8, input, needle) orelse return allocator.dupe(u8, "");
    const colon_rel = std.mem.indexOfScalar(u8, input[start + needle.len ..], ':') orelse return allocator.dupe(u8, "");
    var i = start + needle.len + colon_rel + 1;
    while (i < input.len and std.ascii.isWhitespace(input[i])) i += 1;
    if (i >= input.len or input[i] != '"') return allocator.dupe(u8, "");
    i += 1;
    var out = try allocator.alloc(u8, input.len - i);
    var n: usize = 0;
    while (i < input.len and input[i] != '"') : (i += 1) {
        if (input[i] == '\\' and i + 1 < input.len) {
            i += 1;
            out[n] = switch (input[i]) {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                else => input[i],
            };
        } else {
            out[n] = input[i];
        }
        n += 1;
    }
    return allocator.realloc(out, n);
}

fn cleanAlloc(allocator: std.mem.Allocator, value: []const u8, fallback: []const u8) ![]u8 {
    const source = if (value.len == 0) fallback else value;
    var out = try allocator.alloc(u8, source.len);
    var n: usize = 0;
    for (source) |c| {
        if (c >= 32 or c == '\n' or c == '\t') {
            out[n] = c;
            n += 1;
        }
    }
    return allocator.realloc(out, n);
}

fn nowIso(allocator: std.mem.Allocator) ![]u8 {
    const ts = std.time.timestamp();
    return std.fmt.allocPrint(allocator, "{d}", .{ts});
}

fn makeId(allocator: std.mem.Allocator) ![]u8 {
    var random_bytes: [8]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);
    const value = std.mem.readInt(u64, &random_bytes, .little);
    return std.fmt.allocPrint(allocator, "{d}-{x}", .{ std.time.timestamp(), value });
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

fn loadComments(allocator: std.mem.Allocator, thread: []const u8) ![]Comment {
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql = try std.fmt.allocPrint(allocator, "select hex(id), hex(parent_id), hex(author), hex(body), hex(created_at), score from comments where thread = {s};", .{sql_thread});
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

fn saveComments(allocator: std.mem.Allocator, thread: []const u8, comments: []Comment) !void {
    var sql = std.ArrayList(u8).init(allocator);
    defer sql.deinit();
    const w = sql.writer();
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    try w.print("begin immediate; delete from comments where thread = {s};", .{sql_thread});
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
        try w.print("insert into comments(id, thread, parent_id, author, body, created_at, score) values({s}, {s}, {s}, {s}, {s}, {s}, {d});", .{ id, sql_thread, parent_id, author, body, created_at, c.score });
    }
    try w.writeAll("commit;");
    try sqliteExec(allocator, sql.items);
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

fn listResponse(allocator: std.mem.Allocator, thread: []const u8, sort: []const u8) !void {
    const comments = try loadComments(allocator, thread);
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
        for (comments) |reply| {
            if (std.mem.eql(u8, reply.parent_id, root.id)) {
                try w.writeAll(",");
                try printComment(w, comments, reply);
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
    const reset_enabled = envEnabled(std.heap.page_allocator, "JCOMMENT_PASSWORD_RESET_ENABLED", false);
    const require_login_to_post = envEnabled(std.heap.page_allocator, "JCOMMENT_REQUIRE_LOGIN_TO_POST", false);
    const mode = emailMode(std.heap.page_allocator);
    defer std.heap.page_allocator.free(mode);
    try w.writeAll("{\"voting\":");
    try w.writeAll(if (voting_enabled) "true" else "false");
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
    if (envEnabled(allocator, "JCOMMENT_REQUIRE_LOGIN_TO_POST", false)) {
        if (!envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true)) {
            try jsonError(403, "Forbidden", "Posting requires login, but login is disabled for this site");
            return;
        }
        const token = try bearerToken(allocator);
        defer allocator.free(token);
        if (!try loginTokenValid(allocator, site, token)) {
            try jsonError(401, "Unauthorized", "Login is required to post comments");
            return;
        }
    }

    var comments = try loadComments(allocator, thread);
    defer freeComments(allocator, comments);
    if (comments.len >= max_comments) {
        try jsonError(507, "Insufficient Storage", "Comment store is full");
        return;
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

    var next = try allocator.alloc(Comment, comments.len + 1);
    @memcpy(next[0..comments.len], comments);
    allocator.free(comments);
    comments = next;
    comments[comments.len - 1] = .{
        .id = try makeId(allocator),
        .parent_id = try cleanAlloc(allocator, raw_parent, ""),
        .author = try cleanAlloc(allocator, raw_author, "Anonymous"),
        .body = try cleanAlloc(allocator, raw_body, ""),
        .created_at = try nowIso(allocator),
        .score = 0,
    };
    try saveComments(allocator, thread, comments);
    try listResponse(allocator, thread, sort);
}

fn emailMode(allocator: std.mem.Allocator) []u8 {
    return envOr(allocator, "JCOMMENT_EMAIL_MODE", "none") catch unreachable;
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
    const sql_token = try sqlText(allocator, token);
    defer allocator.free(sql_token);
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_username = try sqlText(allocator, username);
    defer allocator.free(sql_username);
    const sql = try std.fmt.allocPrint(allocator, "insert into sessions(token, site, username) values({s}, {s}, {s});", .{ sql_token, sql_site, sql_username });
    defer allocator.free(sql);
    try sqliteExec(allocator, sql);
    return token;
}

fn accountResponse(allocator: std.mem.Allocator, site: []const u8, username: []const u8) !void {
    const token = try writeSession(allocator, site, username);
    defer allocator.free(token);
    const created = try nowIso(allocator);
    defer allocator.free(created);

    const w = stdout();
    try status(201, "Created");
    try w.writeAll("{\"user\":{\"username\":");
    try std.json.stringify(username, .{}, w);
    try w.writeAll(",\"name\":");
    try std.json.stringify(username, .{}, w);
    try w.writeAll(",\"createdAt\":");
    try std.json.stringify(created, .{}, w);
    try w.writeAll("},\"token\":");
    try std.json.stringify(token, .{}, w);
    try w.writeAll("}");
}

fn handleSignup(allocator: std.mem.Allocator, site: []const u8, body: []const u8) !void {
    const raw_username = try jsonField(allocator, body, "username");
    defer allocator.free(raw_username);
    const raw_email = try jsonField(allocator, body, "email");
    defer allocator.free(raw_email);
    const password = try jsonField(allocator, body, "password");
    defer allocator.free(password);
    const username = try cleanAlloc(allocator, raw_username, "");
    defer allocator.free(username);
    const email = try cleanAlloc(allocator, raw_email, "");
    defer allocator.free(email);
    if (username.len == 0) return jsonError(400, "Bad Request", "Username is required");
    if (password.len < 8) return jsonError(400, "Bad Request", "Password must be at least 8 characters");
    const mode = emailMode(allocator);
    defer allocator.free(mode);
    if (std.mem.eql(u8, mode, "required") and email.len == 0) return jsonError(400, "Bad Request", "Email is required");
    if (std.mem.eql(u8, mode, "none") and email.len != 0) return jsonError(400, "Bad Request", "Email is disabled for this site");
    if (try findAccountLine(allocator, site, username)) |existing| {
        allocator.free(existing);
        return jsonError(409, "Conflict", "Account already exists for this site");
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
    try sqliteExec(allocator, sql);
    try accountResponse(allocator, site, username);
}

fn handleLogin(allocator: std.mem.Allocator, site: []const u8, body: []const u8) !void {
    const raw_username = try jsonField(allocator, body, "username");
    defer allocator.free(raw_username);
    const password = try jsonField(allocator, body, "password");
    defer allocator.free(password);
    const username = try cleanAlloc(allocator, raw_username, "");
    defer allocator.free(username);
    const line = (try findAccountLine(allocator, site, username)) orelse return jsonError(401, "Unauthorized", "Invalid username or password");
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
    const username = try cleanAlloc(allocator, raw_username, "");
    defer allocator.free(username);
    const email = try cleanAlloc(allocator, raw_email, "");
    defer allocator.free(email);
    const line_opt = try findAccountLine(allocator, site, username);
    const w = stdout();
    try status(201, "Created");
    if (line_opt) |line| {
        defer allocator.free(line);
        if (std.mem.eql(u8, accountField(line, 2), email)) {
            const token = try makeId(allocator);
            defer allocator.free(token);
            const sql_site = try sqlText(allocator, site);
            defer allocator.free(sql_site);
            const sql_username = try sqlText(allocator, username);
            defer allocator.free(sql_username);
            const sql_token = try sqlText(allocator, token);
            defer allocator.free(sql_token);
            const sql = try std.fmt.allocPrint(allocator, "insert into resets(site, username, token) values({s}, {s}, {s});", .{ sql_site, sql_username, sql_token });
            defer allocator.free(sql);
            try sqliteExec(allocator, sql);
            if (envEnabled(allocator, "JCOMMENT_PASSWORD_RESET_EXPOSE_TOKEN", false)) {
                try w.writeAll("{\"ok\":true,\"token\":");
                try std.json.stringify(token, .{}, w);
                try w.writeAll("}");
                return;
            }
        }
    }
    try w.writeAll("{\"ok\":true}");
}

fn handleResetConfirm(allocator: std.mem.Allocator, site: []const u8, body: []const u8) !void {
    if (!envEnabled(allocator, "JCOMMENT_PASSWORD_RESET_ENABLED", false)) return jsonError(403, "Forbidden", "Password reset is disabled for this site");
    const token = try jsonField(allocator, body, "token");
    defer allocator.free(token);
    const password = try jsonField(allocator, body, "password");
    defer allocator.free(password);
    if (password.len < 8) return jsonError(400, "Bad Request", "Password must be at least 8 characters");
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_token = try sqlText(allocator, token);
    defer allocator.free(sql_token);
    const query = try std.fmt.allocPrint(allocator, "select hex(username) from resets where site = {s} and token = {s} limit 1;", .{ sql_site, sql_token });
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
    const update = try std.fmt.allocPrint(allocator, "begin immediate; update accounts set password_hash = {s} where site = {s} and username = {s}; delete from resets where site = {s} and token = {s}; commit;", .{ sql_hash, sql_site, sql_username, sql_site, sql_token });
    defer allocator.free(update);
    try sqliteExec(allocator, update);
    const w = stdout();
    try status(201, "Created");
    try w.writeAll("{\"ok\":true}");
}

fn bearerToken(allocator: std.mem.Allocator) ![]u8 {
    const auth = try envOr(allocator, "HTTP_AUTHORIZATION", "");
    defer allocator.free(auth);
    if (!std.mem.startsWith(u8, auth, "Bearer ")) return allocator.dupe(u8, "");
    return allocator.dupe(u8, auth[7..]);
}

fn loginTokenValid(allocator: std.mem.Allocator, site: []const u8, token: []const u8) !bool {
    if (token.len == 0) return false;
    const sql_site = try sqlText(allocator, site);
    defer allocator.free(sql_site);
    const sql_token = try sqlText(allocator, token);
    defer allocator.free(sql_token);
    const sql = try std.fmt.allocPrint(allocator, "select count(*) from sessions where token = {s} and site = {s};", .{ sql_token, sql_site });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    const count_text = std.mem.trim(u8, data, "\r\n\t ");
    return (std.fmt.parseInt(usize, count_text, 10) catch 0) > 0;
}

fn clientIp(allocator: std.mem.Allocator) ![]u8 {
    inline for (.{ "HTTP_CF_CONNECTING_IP", "HTTP_X_REAL_IP", "HTTP_X_FORWARDED_FOR", "REMOTE_ADDR" }) |key| {
        const value = try envOr(allocator, key, "");
        if (value.len > 0) {
            if (std.mem.indexOfScalar(u8, value, ',')) |comma| {
                const trimmed = try allocator.dupe(u8, std.mem.trim(u8, value[0..comma], " "));
                allocator.free(value);
                return trimmed;
            }
            return value;
        }
        allocator.free(value);
    }
    return allocator.dupe(u8, "127.0.0.1");
}

fn isLocalhost(ip: []const u8) bool {
    return std.mem.eql(u8, ip, "localhost") or std.mem.eql(u8, ip, "::1") or std.mem.startsWith(u8, ip, "127.");
}

fn voteSeen(allocator: std.mem.Allocator, thread: []const u8, id: []const u8, identity: []const u8, max_votes: usize) !bool {
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql_id = try sqlText(allocator, id);
    defer allocator.free(sql_id);
    const sql_identity = try sqlText(allocator, identity);
    defer allocator.free(sql_identity);
    const sql = try std.fmt.allocPrint(allocator, "select count(*) from votes where thread = {s} and comment_id = {s} and identity = {s};", .{ sql_thread, sql_id, sql_identity });
    defer allocator.free(sql);
    const data = try sqliteQuery(allocator, sql);
    defer allocator.free(data);
    const seen = std.fmt.parseInt(usize, std.mem.trim(u8, data, "\r\n\t "), 10) catch 0;
    return seen >= max_votes;
}

fn rememberVote(allocator: std.mem.Allocator, thread: []const u8, id: []const u8, identity: []const u8) !void {
    const sql_thread = try sqlText(allocator, thread);
    defer allocator.free(sql_thread);
    const sql_id = try sqlText(allocator, id);
    defer allocator.free(sql_id);
    const sql_identity = try sqlText(allocator, identity);
    defer allocator.free(sql_identity);
    const sql = try std.fmt.allocPrint(allocator, "insert into votes(thread, comment_id, identity) values({s}, {s}, {s});", .{ sql_thread, sql_id, sql_identity });
    defer allocator.free(sql);
    try sqliteExec(allocator, sql);
}

fn handleVote(allocator: std.mem.Allocator, thread: []const u8, site: []const u8, sort: []const u8, body: []const u8) !void {
    if (!envEnabled(allocator, "JCOMMENT_VOTING_ENABLED", true)) {
        try jsonError(403, "Forbidden", "Voting is disabled for this site");
        return;
    }

    var comments = try loadComments(allocator, thread);
    defer freeComments(allocator, comments);

    const id = try jsonField(allocator, body, "id");
    defer allocator.free(id);
    var index: ?usize = null;
    for (comments, 0..) |c, i| {
        if (std.mem.eql(u8, c.id, id)) index = i;
    }
    const found = index orelse {
        try jsonError(404, "Not Found", "Comment was not found");
        return;
    };

    const max_text = try envOr(allocator, "JCOMMENT_MAX_VOTES_PER_IDENTITY", "1");
    defer allocator.free(max_text);
    const max_votes = @max(@as(usize, 1), std.fmt.parseInt(usize, max_text, 10) catch 1);

    const login_enabled = envEnabled(allocator, "JCOMMENT_LOGIN_ENABLED", true);
    const token = try bearerToken(allocator);
    defer allocator.free(token);
    const identity = blk: {
        if (login_enabled and try loginTokenValid(allocator, site, token)) {
            break :blk try std.fmt.allocPrint(allocator, "login:{s}", .{token});
        }
        const ip = try clientIp(allocator);
        defer allocator.free(ip);
        if (isLocalhost(ip)) {
            break :blk try std.fmt.allocPrint(allocator, "localhost:{s}", .{ip});
        }
        if (!login_enabled) {
            break :blk try std.fmt.allocPrint(allocator, "anonymous:{d}", .{std.time.nanoTimestamp()});
        }
        try jsonError(401, "Unauthorized", "Login is required to vote from this network");
        return;
    };
    defer allocator.free(identity);

    if (try voteSeen(allocator, thread, id, identity, max_votes)) {
        try jsonError(429, "Too Many Requests", "Vote limit reached for this identity");
        return;
    }
    try rememberVote(allocator, thread, id, identity);
    comments[found].score += 1;
    try saveComments(allocator, thread, comments);
    try listResponse(allocator, thread, sort);
}
