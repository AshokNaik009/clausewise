export const PORT_VERSION = "0.1.0";

export const PARITY_MILESTONES = [
  {
    stage: 1,
    name: "Local runtime and CLI foundation",
    status: "implemented",
    features: [
      "TypeScript Deep Agents runtime with filesystem tools and bounded, cancellable local shell execution",
      "Manual tool approvals, rejection, and durable interrupt resume",
      "Atomic checkpoints with single-writer session locking",
      "Shared server-backed interactive and headless text/JSON/JSONL execution",
      "SDK project AGENTS.md, skills, and general-purpose delegation",
    ],
    limitations: [
      "Local execution is not a security sandbox",
      "Checkpoints remain full snapshots capped at 64 MiB; no Python SQLite-session import",
      "Continuing a cancelled or crashed turn can replay uncheckpointed tool effects",
      "Crash-stale session locks require manual recovery",
    ],
  },
  {
    stage: 2,
    name: "Terminal UI and client/server transport",
    status: "partial",
    features: [
      "Separate child-process server with validated versioned IPC, request/run/event IDs, heartbeat, and event acknowledgements",
      "Server-owned sessions, serialized controls, cancellation, and graceful shutdown",
      "Ink transcript, multiline composer, command completion, scrollback, resize handling, tool output, and approval panels",
      "Thread/model pickers, masked credential input, and persistent mode indicators",
      "Responsibility-based source folders with stable CLI and public entry points",
    ],
    limitations: [
      "No detached server reconnect/event replay or queued prompts",
      "Approval replacement previews are not a complete filesystem diff viewer",
      "Terminal accessibility, full-width Unicode layout, themes, and full slash-command parity remain incomplete",
      "Real-provider streaming and exhaustive crash/nested-cancellation scenarios are not verified",
    ],
  },
  {
    stage: 3,
    name: "Configuration, providers, and session controls",
    status: "partial",
    features: [
      "Versioned JSON configuration with managed/CLI/runtime/environment/user/project/default precedence, provenance, and last-good file snapshots",
      "Explicit reload, named OpenAI-compatible providers, endpoint-bound private credential files, and conversation-preserving model switching",
      "Manual mode, restricted classifier-backed Auto for eligible source edits, and explicitly acknowledged session-scoped YOLO",
      "Durable completed-request usage records, user-configured token prices, cache/reasoning dimensions, and explicit unknown costs",
      "Bounded session memory, persistent goals and acceptance criteria, and approval-gated goal updates",
      "Explicit compaction with conversation archives, recovery markers, and preserved usage/goal state",
    ],
    limitations: [
      "JSON configuration is deliberately separate from upstream TOML; no full manifest compatibility or config writer UI",
      "Only OpenAI-compatible adapters; no native Anthropic/Google adapters or provider OAuth",
      "Restricted Auto is narrower than upstream; shell, delegation, protected paths, and integrations still require human review",
      "Usage records cover completed model callbacks, not authoritative billing for failed/partially streamed provider requests",
      "No bundled price catalog, cross-session memory manager, separate summary model, or archive-restore UI",
      "Explicit compaction accepts at most 300,000 conversation characters; full checkpoints still retain historical snapshots",
    ],
  },
  {
    stage: 4,
    name: "Extensions and external capabilities",
    status: "partial",
    features: [
      "Explicitly trusted MCP stdio and Streamable HTTP connections, namespaced tools, bounded calls, and inherited approval gates",
      "Bounded direct-exec hooks for prompt submission, tools, compaction, and turn completion",
      "Versioned, checksum-verified declarative plugin manifests and custom agents with inherited model, middleware, and approval policy",
      "Configured and observed tool inventory with integration diagnostics",
      "Public web fetch with address validation, redirect revalidation, DNS pinning, timeouts, and response limits",
      "Optional Tavily search; external web tools are disabled by default and search is hidden without credentials",
    ],
    limitations: [
      "MCP OAuth, interactive enable/disable, legacy SSE, and live tool-list refresh are pending",
      "Hook events, matcher precedence, and output semantics are a restricted subset of upstream",
      "Plugins contribute declarative MCP/hooks/agents only; arbitrary TypeScript/Python extension execution and backend routes are not implemented",
      "Custom agents currently share the parent model and extension tools",
      "Integration definitions require restart; live remote MCP and web requests have not been verified",
      "Remote sandboxes, ACP, onboarding, packaging, updates, and broader diagnostics remain pending",
    ],
  },
] as const;
