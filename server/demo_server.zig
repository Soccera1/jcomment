const std = @import("std");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const port_text = std.process.getEnvVarOwned(allocator, "PORT") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, "8787"),
        else => return err,
    };
    defer allocator.free(port_text);
    const port = try std.fmt.parseInt(u16, port_text, 10);

    try std.fs.cwd().makePath("dist/.demo-data");
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
        const reader = try request.reader();
        const body = try reader.readAllAlloc(allocator, 8192);
        defer allocator.free(body);
        const response = try runCgi(allocator, request, target, body);
        defer allocator.free(response);
        try respondRaw(request, response);
        return;
    }
    try serveStatic(allocator, request, path);
}

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
    child.stderr_behavior = .Pipe;
    var env_map = try std.process.getEnvMap(allocator);
    defer env_map.deinit();
    child.env_map = &env_map;
    try env_map.put("JCOMMENT_DATA_DIR", "dist/.demo-data");
    try env_map.put("JCOMMENT_EMAIL_MODE", "optional");
    try env_map.put("JCOMMENT_PASSWORD_RESET_ENABLED", "1");
    try env_map.put("JCOMMENT_PASSWORD_RESET_EXPOSE_TOKEN", "1");
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

fn respondRaw(request: *std.http.Server.Request, cgi: []const u8) !void {
    const split = std.mem.indexOf(u8, cgi, "\r\n\r\n") orelse 0;
    const body = if (split == 0) cgi else cgi[split + 4 ..];
    var status: std.http.Status = .ok;
    if (split != 0) {
        var lines = std.mem.splitSequence(u8, cgi[0..split], "\r\n");
        while (lines.next()) |line| {
            if (std.mem.startsWith(u8, line, "Status: ")) {
                const code = std.fmt.parseInt(u10, line[8..11], 10) catch 200;
                status = @enumFromInt(code);
            }
        }
    }
    try request.respond(body, .{
        .status = status,
        .extra_headers = &.{
            .{ .name = "content-type", .value = "application/json; charset=utf-8" },
            .{ .name = "access-control-allow-origin", .value = "*" },
        },
    });
}

fn serveStatic(allocator: std.mem.Allocator, request: *std.http.Server.Request, path: []const u8) !void {
    const clean = if (std.mem.eql(u8, path, "/"))
        "/demo/index.html"
    else if (std.mem.endsWith(u8, path, "/"))
        try std.fmt.allocPrint(allocator, "{s}index.html", .{path})
    else
        path;
    defer if (!std.mem.eql(u8, clean, path) and !std.mem.eql(u8, clean, "/demo/index.html")) allocator.free(clean);
    if (std.mem.indexOf(u8, clean, "..") != null) return request.respond("Not found", .{ .status = .not_found });
    const file_path = try std.fmt.allocPrint(allocator, "dist{s}", .{clean});
    defer allocator.free(file_path);
    const file = std.fs.cwd().openFile(file_path, .{}) catch return request.respond("Not found", .{ .status = .not_found });
    defer file.close();
    const data = try file.readToEndAlloc(allocator, 8 * 1024 * 1024);
    defer allocator.free(data);
    try request.respond(data, .{
        .extra_headers = &.{.{ .name = "content-type", .value = contentType(clean) }},
    });
}

fn contentType(path: []const u8) []const u8 {
    if (std.mem.endsWith(u8, path, ".html")) return "text/html; charset=utf-8";
    if (std.mem.endsWith(u8, path, ".js")) return "text/javascript; charset=utf-8";
    return "application/octet-stream";
}
