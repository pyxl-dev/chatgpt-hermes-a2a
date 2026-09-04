import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bridge = path.join(root, "scripts", "start-bridge.sh");
const proofFile = "/tmp/chatgpt-hermes-a2a-proof.txt";
const proofText = "HERMES_A2A_TOOL_OK";

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

function extractText(result) {
  const parts = Array.isArray(result && result.content) ? result.content : [];
  return parts
    .map((part) => {
      if (part && part.type === "text") return part.text || "";
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .filter(Boolean)
    .join("\n");
}

function preview(value, max = 2500) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  if (!rendered) return "";
  return rendered.length > max
    ? rendered.slice(0, max) + "…[truncated]"
    : rendered;
}

const summary = {
  ok: false,
  tools: [],
  listAgents: null,
  agentCard: null,
  sendMessage: null,
  localToolProof: false,
  error: null,
};

const transport = new StdioClientTransport({
  command: bridge,
  args: [],
  env: childEnv,
  stderr: "pipe",
});

const client = new Client(
  { name: "chatgpt-hermes-a2a-smoke", version: "0.1.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);

  const listed = await client.listTools();
  summary.tools = (listed.tools || []).map((tool) => tool.name);

  const required = [
    "a2a_list_agents",
    "a2a_get_agent_card",
    "a2a_send_message",
  ];
  const missing = required.filter((name) => !summary.tools.includes(name));
  if (missing.length) {
    throw new Error(
      "MCP bridge is up but required tools are missing: " + missing.join(", "),
    );
  }

  const agents = await client.callTool({
    name: "a2a_list_agents",
    arguments: {},
  });
  summary.listAgents = preview(extractText(agents) || agents);

  const card = await client.callTool({
    name: "a2a_get_agent_card",
    arguments: { agent: "hermes" },
  });
  summary.agentCard = preview(extractText(card) || card);

  await fs.rm(proofFile, { force: true });

  const request = {
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [
        {
          text:
            "This is an automated local diagnostic. Use your local shell/terminal tool to create " +
            proofFile +
            " containing exactly " +
            proofText +
            " with no trailing commentary in the file. Then read the file back. " +
            "Do not modify any other file, setting, repository, or service. " +
            "Reply with " +
            proofText +
            " if the operation succeeded.",
        },
      ],
    },
  };

  const sent = await client.callTool({
    name: "a2a_send_message",
    arguments: { agent: "hermes", request },
  });
  summary.sendMessage = preview(extractText(sent) || sent);

  try {
    const onDisk = (await fs.readFile(proofFile, "utf8")).trim();
    summary.localToolProof = onDisk === proofText;
  } catch {
    summary.localToolProof = false;
  }

  if (!summary.localToolProof) {
    throw new Error(
      "Hermes answered through A2A, but the local tool proof file was not created with the expected content.",
    );
  }

  summary.ok = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } catch {}
}

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
