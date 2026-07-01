import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

dotenv.config();

const PORT = Number(process.env.PORT || 8788);
const transports = {};

const WIDGET_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Test Widget</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        background: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 24px;
      }
      .message {
        font-size: 20px;
        font-weight: 500;
        color: #111;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <p class="message">This is test app</p>
    <script>
      window.addEventListener("load", function () {
        try {
          window.parent.postMessage({ type: "uiReady" }, "*");
          window.parent.postMessage({ type: "skybridge:ready" }, "*");
          window.parent.postMessage({ type: "loaded" }, "*");
        } catch (e) {}
      });
    </script>
  </body>
</html>`;

function createServer() {
  const server = new McpServer({
    name: "mcp-widget-test",
    version: "1.0.0"
  });

  server.registerResource(
    "test-widget-ui",
    "ui://test/widget.html",
    {
      mimeType: "text/html+skybridge",
      description: "Minimal test widget"
    },
    async () => ({
      contents: [
        {
          uri: "ui://test/widget.html",
          mimeType: "text/html+skybridge",
          text: WIDGET_HTML,
          _meta: {
            ui: { prefersBorder: true },
            "openai/widgetDescription": "Minimal test widget",
            "openai/widgetPrefersBorder": true
          }
        }
      ]
    })
  );

  server.registerTool(
    "open_test_widget",
    {
      title: "Open Test Widget",
      description: "Opens a minimal test widget in the chat to verify skybridge rendering works.",
      inputSchema: {},
      _meta: {
        ui: { resourceUri: "ui://test/widget.html" },
        "openai/outputTemplate": "ui://test/widget.html",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening test widget...",
        "openai/toolInvocation/invoked": "Test widget ready"
      }
    },
    async () => ({
      content: [{ type: "text", text: "Test widget opened." }],
      structuredContent: { opened: true }
    })
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json());

app.options("/mcp", cors());

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) delete transports[sid];
      };

      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID" },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`MCP test server running at http://localhost:${PORT}/mcp`);
});

process.on("SIGINT", async () => {
  for (const id in transports) {
    await transports[id].close();
    delete transports[id];
  }
  process.exit(0);
});
