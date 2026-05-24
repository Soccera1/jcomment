const std = @import("std");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    if (std.process.hasEnvVarConstant("JCOMMENT_DEMO_SELF_TEST")) {
        try demoSelfTest();
        return;
    }

    const port_text = std.process.getEnvVarOwned(allocator, "PORT") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, "8787"),
        else => return err,
    };
    defer allocator.free(port_text);
    const port = try std.fmt.parseInt(u16, port_text, 10);

    try ensureDemoDataDir();
    var server = try std.net.Address.listen(try std.net.Address.parseIp("127.0.0.1", port), .{ .reuse_address = true });
    defer server.deinit();

    std.debug.print("jcomment demo on http://127.0.0.1:{d}/demo/\n", .{port});

    while (true) {
        const connection = try server.accept();
        handleConnection(allocator, connection) catch |err| {
            std.debug.print("demo request failed: {}\n", .{err});
            connection.stream.close();
        };
    }
}

fn handleConnection(allocator: std.mem.Allocator, connection: std.net.Server.Connection) !void {
    defer connection.stream.close();
    var read_buffer: [16384]u8 = undefined;
    var http_server = std.http.Server.init(connection, &read_buffer);

    while (http_server.state == .ready) {
        var request = http_server.receiveHead() catch |err| switch (err) {
            error.HttpConnectionClosing => return,
            else => return err,
        };
        try handleRequest(allocator, &request);
    }
}

fn handleRequest(allocator: std.mem.Allocator, request: *std.http.Server.Request) !void {
    const target = request.head.target;
    const path = target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
    if (std.mem.eql(u8, path, "/api/comments") or std.mem.startsWith(u8, path, "/api/comments/")) {
        if (!validApiPath(path)) {
            return request.respond("{\"error\":\"Not found\"}", .{
                .status = .not_found,
                .extra_headers = &.{
                    .{ .name = "content-type", .value = "application/json; charset=utf-8" },
                    .{ .name = "cache-control", .value = "no-store" },
                    .{ .name = "pragma", .value = "no-cache" },
                    .{ .name = "x-content-type-options", .value = "nosniff" },
                },
            });
        }
        const method = @tagName(request.head.method);
        if (!validApiMethod(path, method)) {
            return request.respond("{\"error\":\"Method not allowed\"}", .{
                .status = .method_not_allowed,
                .extra_headers = &apiHeaders,
            });
        }
        const body = if (std.mem.eql(u8, method, "POST") or std.mem.eql(u8, method, "PATCH")) blk: {
            const reader = try request.reader();
            break :blk reader.readAllAlloc(allocator, 8192) catch |err| switch (err) {
                error.StreamTooLong => {
                    try request.respond("{\"error\":\"Request body is too large\"}", .{
                        .status = .payload_too_large,
                        .extra_headers = &apiHeaders,
                    });
                    return;
                },
                else => return err,
            };
        } else try allocator.dupe(u8, "");
        defer allocator.free(body);
        const response = try runCgi(allocator, request, target, body);
        defer allocator.free(response);
        try respondRaw(request, response);
        return;
    }
    try serveStatic(allocator, request, path);
}

const apiHeaders = [_]std.http.Header{
    .{ .name = "content-type", .value = "application/json; charset=utf-8" },
    .{ .name = "cache-control", .value = "no-store" },
    .{ .name = "pragma", .value = "no-cache" },
    .{ .name = "x-content-type-options", .value = "nosniff" },
};

fn runCgi(
    allocator: std.mem.Allocator,
    request: *std.http.Server.Request,
    target: []const u8,
    body: []const u8,
) ![]u8 {
    const query = if (std.mem.indexOfScalar(u8, target, '?')) |i| target[i + 1 ..] else "";
    const path = target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
    var child = std.process.Child.init(&.{"./dist/jcomment-cgi"}, allocator);
    child.stdin_behavior = .Pipe;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    var env_map = try initCgiEnv(allocator);
    defer env_map.deinit();
    child.env_map = &env_map;
    try env_map.put("REQUEST_METHOD", @tagName(request.head.method));
    try env_map.put("PATH_INFO", path);
    try env_map.put("QUERY_STRING", query);
    try env_map.put("REMOTE_ADDR", "127.0.0.1");
    const content_length = try std.fmt.allocPrint(allocator, "{d}", .{body.len});
    defer allocator.free(content_length);
    try env_map.put("CONTENT_LENGTH", content_length);
    if (request.head.content_type) |content_type| try env_map.put("CONTENT_TYPE", content_type);

    try child.spawn();
    if (body.len > 0) try child.stdin.?.writeAll(body);
    child.stdin.?.close();
    child.stdin = null;
    const stdout = try child.stdout.?.readToEndAlloc(allocator, 1024 * 1024);
    errdefer allocator.free(stdout);
    const term = try child.wait();
    if (term.Exited != 0) return error.CgiFailed;
    return stdout;
}

fn initCgiEnv(allocator: std.mem.Allocator) !std.process.EnvMap {
    var env_map = std.process.EnvMap.init(allocator);
    errdefer env_map.deinit();
    try env_map.put("JCOMMENT_DATA_DIR", "dist/.demo-data");
    try env_map.put("JCOMMENT_EMAIL_MODE", "optional");
    try env_map.put("JCOMMENT_PASSWORD_RESET_ENABLED", "1");
    try env_map.put("JCOMMENT_PASSWORD_RESET_COMMAND", "/bin/true");
    try env_map.put("SERVER_NAME", "127.0.0.1");
    try env_map.put("REQUEST_SCHEME", "http");
    return env_map;
}

fn ensureDemoDataDir() !void {
    std.fs.cwd().makePath("dist/.demo-data") catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    var data_dir = try std.fs.cwd().openDir("dist/.demo-data", .{ .no_follow = true });
    defer data_dir.close();
    try std.posix.fchmodat(std.fs.cwd().fd, "dist/.demo-data", 0o700, 0);
}

fn respondRaw(request: *std.http.Server.Request, cgi: []const u8) !void {
    const split = std.mem.indexOf(u8, cgi, "\r\n\r\n") orelse 0;
    const body = if (split == 0) cgi else cgi[split + 4 ..];
    var status: std.http.Status = .ok;
    if (split != 0) {
        var lines = std.mem.splitSequence(u8, cgi[0..split], "\r\n");
        while (lines.next()) |line| {
            if (std.mem.startsWith(u8, line, "Status: ")) {
                status = parseCgiStatus(line);
            }
        }
    }
    try request.respond(body, .{
        .status = status,
        .extra_headers = &.{
            .{ .name = "content-type", .value = "application/json; charset=utf-8" },
            .{ .name = "cache-control", .value = "no-store" },
            .{ .name = "pragma", .value = "no-cache" },
            .{ .name = "x-content-type-options", .value = "nosniff" },
        },
    });
}

fn parseCgiStatus(line: []const u8) std.http.Status {
    if (line.len < 11 or line[8] < '1' or line[8] > '5' or !std.ascii.isDigit(line[9]) or !std.ascii.isDigit(line[10])) {
        return .ok;
    }
    const code = std.fmt.parseInt(u10, line[8..11], 10) catch return .ok;
    return @enumFromInt(code);
}

fn serveStatic(allocator: std.mem.Allocator, request: *std.http.Server.Request, path: []const u8) !void {
    const clean = if (std.mem.eql(u8, path, "/"))
        "/demo/index.html"
    else if (std.mem.endsWith(u8, path, "/"))
        try std.fmt.allocPrint(allocator, "{s}index.html", .{path})
    else
        path;
    defer if (!std.mem.eql(u8, clean, path) and !std.mem.eql(u8, clean, "/demo/index.html")) allocator.free(clean);
    if (std.mem.indexOf(u8, clean, "..") != null) return staticNotFound(request);
    if (hasHiddenPathComponent(clean)) return staticNotFound(request);
    if (!validStaticPath(clean)) return staticNotFound(request);
    const file_path = try std.fmt.allocPrint(allocator, "dist{s}", .{clean});
    defer allocator.free(file_path);
    const file = std.fs.cwd().openFile(file_path, .{}) catch return staticNotFound(request);
    defer file.close();
    const data = try file.readToEndAlloc(allocator, 8 * 1024 * 1024);
    defer allocator.free(data);
    try request.respond(data, .{
        .extra_headers = &.{
            .{ .name = "content-type", .value = contentType(clean) },
            .{ .name = "x-content-type-options", .value = "nosniff" },
        },
    });
}

fn staticNotFound(request: *std.http.Server.Request) !void {
    return request.respond("Not found", .{
        .status = .not_found,
        .extra_headers = &.{
            .{ .name = "cache-control", .value = "no-store" },
            .{ .name = "pragma", .value = "no-cache" },
            .{ .name = "x-content-type-options", .value = "nosniff" },
        },
    });
}

fn contentType(path: []const u8) []const u8 {
    if (std.mem.endsWith(u8, path, ".html")) return "text/html; charset=utf-8";
    if (std.mem.endsWith(u8, path, ".js")) return "text/javascript; charset=utf-8";
    return "application/octet-stream";
}

fn hasHiddenPathComponent(path: []const u8) bool {
    var parts = std.mem.splitScalar(u8, path, '/');
    while (parts.next()) |part| {
        if (part.len > 0 and part[0] == '.') return true;
    }
    return false;
}

fn validApiPath(path: []const u8) bool {
    return std.mem.eql(u8, path, "/api/comments") or
        std.mem.eql(u8, path, "/api/comments/signup") or
        std.mem.eql(u8, path, "/api/comments/login") or
        std.mem.eql(u8, path, "/api/comments/reset/request") or
        std.mem.eql(u8, path, "/api/comments/reset/confirm");
}

fn validApiMethod(path: []const u8, method: []const u8) bool {
    if (std.mem.eql(u8, method, "OPTIONS")) return true;
    if (std.mem.eql(u8, path, "/api/comments")) {
        return std.mem.eql(u8, method, "GET") or std.mem.eql(u8, method, "POST") or std.mem.eql(u8, method, "PATCH");
    }
    return std.mem.eql(u8, method, "POST");
}

fn validStaticPath(path: []const u8) bool {
    return std.mem.eql(u8, path, "/demo/index.html") or
        std.mem.eql(u8, path, "/jcomment.js");
}

fn demoSelfTest() !void {
    if (!hasHiddenPathComponent("/.demo-data/accounts.tsv")) return error.HiddenDemoDataAllowed;
    if (!hasHiddenPathComponent("/demo/.secret")) return error.HiddenNestedFileAllowed;
    if (hasHiddenPathComponent("/demo/index.html")) return error.PublicDemoRejected;
    if (!validStaticPath("/demo/index.html")) return error.DemoIndexRejected;
    if (!validStaticPath("/jcomment.js")) return error.WidgetRejected;
    if (validStaticPath("/jcomment-cgi")) return error.CgiBinaryAllowed;
    if (validStaticPath("/jcomment-demo.o")) return error.DemoObjectAllowed;
    if (!validApiPath("/api/comments")) return error.ApiRootRejected;
    if (!validApiPath("/api/comments/login")) return error.ApiLoginRejected;
    if (validApiPath("/api/comments/anything/login")) return error.NestedApiLoginAllowed;
    if (!validApiMethod("/api/comments", "GET")) return error.ApiGetRejected;
    if (!validApiMethod("/api/comments", "PATCH")) return error.ApiPatchRejected;
    if (!validApiMethod("/api/comments/login", "POST")) return error.ApiLoginPostRejected;
    if (validApiMethod("/api/comments/login", "PATCH")) return error.ApiLoginPatchAllowed;
    if (validApiMethod("/api/comments", "PUT")) return error.ApiPutAllowed;
    if (parseCgiStatus("Status: ") != .ok) return error.ShortStatusAccepted;
    if (parseCgiStatus("Status: abc") != .ok) return error.NonNumericStatusAccepted;
    if (parseCgiStatus("Status: 404 Not Found") != .not_found) return error.ValidStatusRejected;
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var env_map = try initCgiEnv(gpa.allocator());
    defer env_map.deinit();
    try env_map.put("REQUEST_METHOD", "GET");
    try env_map.put("PATH_INFO", "/api/comments");
    if (env_map.get("JCOMMENT_DB") != null) return error.ParentEnvironmentInherited;
    if (!std.mem.eql(u8, env_map.get("JCOMMENT_DATA_DIR") orelse "", "dist/.demo-data")) return error.DemoDataDirMissing;
    std.debug.print("demo server ok\n", .{});
}
