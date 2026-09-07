import type { AgentClient } from "../client/agent-client.js";
import { COMMANDS, type CommandName } from "../cli/commands.js";
import { PARITY_MILESTONES, PORT_VERSION } from "../shared/parity.js";
import { goalUpdateSchema } from "../protocol/session-controls.js";
import type { PickerItem } from "./widgets/Picker.js";
import { copyText, exportConversation, openUrl, readUserText } from "./desktop.js";

export interface CommandUi {
  client: AgentClient;
  print: (text: string) => void;
  select: (id: string | null) => Promise<void>;
  pick: (title: string, items: PickerItem[], choose: (value: string) => Promise<void>, command?: string | null) => void;
  confirm: (title: string, text: string, accept: () => Promise<void>) => void;
  run: (prompt: string) => Promise<void>;
  auth: () => void;
  yolo: () => void;
  installUpdate?: (plan: import("../cli/updates.js").UpdatePlan) => Promise<void>;
}

function modelSelection(value: string, client: AgentClient) {
  const separator = value.indexOf(":");
  return { provider: separator > 0 ? value.slice(0, separator) : client.session.provider ?? "openai", model: separator > 0 ? value.slice(separator + 1) : value };
}

async function resume(argument: string, ui: CommandUi): Promise<void> {
  const sessions = await ui.client.sessions();
  const matches = argument ? sessions.filter((session) => session.id.startsWith(argument)) : sessions.filter((session) => session.cwd === ui.client.session.cwd && session.id !== ui.client.session.id).slice(0, 1);
  if (matches.length !== 1) throw new Error(matches.length ? "Session prefix is ambiguous" : "No matching session");
  await ui.select(matches[0]!.id);
}

export async function executeCommand(name: CommandName | null, argument: string, ui: CommandUi): Promise<void> {
  const { client, print } = ui;
  const show = (value: unknown) => print(`\n${JSON.stringify(value, null, 2)}\n`);
  switch (name) {
    case "help": print(`\n${COMMANDS.map((entry) => `/${entry.name.padEnd(22)} ${entry.description}`).join("\n")}\n`); return;
    case "skills": ui.pick("Select a skill", (await client.skills()).map((skill) => ({ value: skill.name, label: `${skill.name}: ${skill.description}` })), async (name) => ui.run(await client.skill(name, "")), "/skill"); return;
    case "skill": {
      const [name = "", ...args] = argument.split(/\s+/u);
      await ui.run(await client.skill(name, args.join(" "))); return;
    }
    case "skill-creator": await ui.run(`Create or refine a reusable Agent Skills SKILL.md for the following task. Inspect existing project skill conventions first. Use YAML frontmatter with name and description and concise reusable instructions. Propose writes through the normal approval tools; do not install dependencies or change approval policy. Task: ${argument || "Derive a useful reusable skill from this conversation."}`); return;
    case "trace": { const url = await client.trace(); print(`\n${url}\n`); await openUrl(url); return; }
    case "docs": case "changelog": case "feedback": {
      const urls = { docs: "https://docs.langchain.com/oss/python/deepagents/code", changelog: "https://github.com/langchain-ai/deepagents/blob/main/libs/code/CHANGELOG.md", feedback: "https://github.com/langchain-ai/deepagents/issues/new/choose" };
      print(`\nUpstream reference (this TypeScript port can differ): ${urls[name]}\n`); await openUrl(urls[name]); return;
    }
    case "version": print(`\ndcode-ts ${PORT_VERSION}\n`); return;
    case "parity": show(PARITY_MILESTONES); return;
    case "clear": await ui.select(null); return;
    case "resume": await resume(argument, ui); return;
    case "threads": {
      if (argument === "-r" || argument.startsWith("-r ")) { await resume(argument.slice(2).trim(), ui); return; }
      if (argument) throw new Error("Use /threads or /threads -r [id]");
      const settings = (await client.configure()).settings;
      const field = settings.threadSortOrder === "created_at" ? "createdAt" : "updatedAt";
      const sessions = (await client.sessions()).sort((a, b) => b[field].localeCompare(a[field]));
      const time = (stamp: string) => settings.threadRelativeTime === false ? stamp : `${Math.max(0, Math.floor((Date.now() - Date.parse(stamp)) / 60_000))}m ago`;
      ui.pick("Resume a session", sessions.map((session) => ({ value: session.id, label: `${session.title ?? session.id} | ${time(session[field])} | ${session.model}${settings.hideCwd ? "" : ` | ${session.cwd}`}` })), ui.select); return;
    }
    case "rename": await client.rename(argument); print("\nSession renamed.\n"); return;
    case "history": for (const message of await client.history()) print(`\n${message.role}: ${message.text}\n`); return;
    case "copy": {
      const text = (await client.history()).filter(({ role }) => role === "ai").at(-1)?.text;
      if (!text) throw new Error("No assistant answer to copy");
      await copyText(text); print("\nLatest answer copied.\n"); return;
    }
    case "export": await exportConversation(client, argument); print("\nConversation exported to a new private file.\n"); return;
    case "tokens": show({ retainedRoot: (await client.result()).usage, durable: (await client.result()).costs }); return;
    case "context": {
      const history = await client.history();
      show({ messages: history.length, characters: history.reduce((sum, item) => sum + item.text.length, 0), usage: (await client.result()).usage });
      print("Provider context limits and exact prompt tokenization are not inferred from character counts.\n"); return;
    }
    case "context-doctor": show({ configuration: await client.configure(), sessionContext: await client.controls(), inventory: await client.inventory() }); return;
    case "model": case "summarization-model": {
      const choose = async (value: string) => {
        const selection = modelSelection(value, client);
        if (name === "model") await client.switchModel(selection.provider, selection.model);
        else await client.settings({ summaryModel: value === "clear" ? null : selection });
        print(`\n${name} updated; conversation preserved.\n`);
      };
      if (argument) await choose(argument);
      else ui.pick(name === "model" ? "Choose a model" : "Choose summary model", (await client.models()).map(({ provider, model }) => ({ value: `${provider}:${model}`, label: `${provider}:${model}` })), choose);
      return;
    }
    case "agents": {
      const choose = async (value: string) => { await client.settings({ agent: value === "clear" ? null : value }); print(`\nRoot agent: ${value === "clear" ? "default" : value}\n`); };
      if (argument) await choose(argument);
      else ui.pick("Choose root agent", [{ value: "clear", label: "Default coding agent" }, ...(await client.inventory()).agents.map((agent) => ({ value: agent.name, label: `${agent.name}: ${agent.description}` }))], choose);
      return;
    }
    case "effort": if (argument) show(await client.settings({ reasoningEffort: argument === "clear" ? null : argument })); else show((await client.configure()).settings.reasoningEffort ?? "provider default"); return;
    case "config": {
      if (!argument) { show(await client.configure()); return; }
      const match = /^(set|unset)\s+(?:(--user)\s+)?(\w+)(?:\s+([\s\S]+))?$/u.exec(argument);
      if (!match) throw new Error("Use /config set [--user] key <JSON value> or /config unset [--user] key");
      const value: unknown = match[1] === "unset" ? null : JSON.parse(match[4] ?? "");
      show(await client.settings({ [match[3]!]: value }, match[2] ? "user" : "session"));
      if (match[3] === "extensionsEnabled") show(await client.integrations("reload"));
      return;
    }
    case "reload": show(await client.configure(true)); show(await client.integrations("reload")); return;
    case "auth": if (argument === "set") ui.auth(); else if (argument) throw new Error("Use /auth or /auth set; never paste keys into commands"); else show(await client.authenticate()); return;
    case "manual": await client.setMode("manual"); print("\nManual approval mode.\n"); return;
    case "auto":
      if (argument.startsWith("model ")) show(await client.settings({ autoClassifierModel: argument.slice(6) === "clear" ? null : modelSelection(argument.slice(6), client) }));
      else if (argument === "model") ui.pick("Choose Auto classifier", (await client.models()).map(({ provider, model }) => ({ value: `${provider}:${model}`, label: `${provider}:${model}` })), async (value) => { await client.settings({ autoClassifierModel: modelSelection(value, client) }); });
      else if (argument) throw new Error("Use /auto or /auto model [provider:model|clear]");
      else { await client.setMode("auto"); print("\nRestricted Auto: source edits are classified; shell, delegation, integrations, and uncertainty require review.\n"); }
      return;
    case "yolo": ui.yolo(); return;
    case "cost": show((await client.result()).costs); print("Unknown prices remain unknown. Estimates are not provider invoices.\n"); return;
    case "compact": show(await client.compact()); return;
    case "archives": {
      const restore = async (id: string) => ui.confirm("Restore archive into a new session", "The current session and archive are preserved. Only completed conversation history is restored; approval grants, goals, credentials, and billed usage are not copied.", async () => { const session = await client.restoreArchive(id); await ui.select(session.id); });
      if (argument.startsWith("restore ")) await restore(argument.slice(8).trim());
      else if (argument) throw new Error("Use /archives or /archives restore <id>");
      else ui.pick("Restore conversation archive", (await client.archives()).map((archive) => ({ value: archive.id, label: `${archive.createdAt} | ${archive.messages} messages | ${archive.summary.slice(0, 80)}` })), restore, "/archives restore");
      return;
    }
    case "remember": if (!argument) throw new Error("Use /remember <trusted context>; never store credentials"); await client.remember(`${(await client.controls()).memory}\n${argument}`.trim()); print("\nContext saved.\n"); return;
    case "memory":
      if (argument.startsWith("set ")) await client.remember(argument.slice(4));
      else if (argument === "clear") await client.remember("");
      else if (argument) throw new Error("Use /memory, /memory set <text>, or /memory clear");
      show((await client.controls()).memory); return;
    case "goal": case "rubric": {
      const [verb = "", ...words] = argument.split(/\s+/u);
      const value = words.join(" ");
      if (!argument || verb === "show") { show((await client.controls())[name]); return; }
      if (verb === "model") {
        if (value) await client.goalOptions(name, { model: value === "clear" ? null : (() => { const selected = modelSelection(value, client); return `${selected.provider}:${selected.model}`; })() });
        else ui.pick(`Choose ${name} model`, [{ value: "clear", label: "Use parent model" }, ...(await client.models()).map(({ provider, model }) => ({ value: `${provider}:${model}`, label: `${provider}:${model}` }))], async (selected) => { await client.goalOptions(name, { model: selected === "clear" ? null : selected }); }, `/${name} model`);
        return;
      }
      if (verb === "max-iterations") { if (value) await client.goalOptions(name, { maxIterations: Number(value) }); show((await client.controls())[name]); return; }
      if (verb === "grade") { show(await client.goalWork(name, "grade")); return; }
      if (verb === "clear") { if (name === "goal") await client.clearGoal(); else await client.setRubric(null); show((await client.controls())[name]); return; }
      if (name === "rubric") {
        const text = verb === "file" ? await readUserText(client.session.cwd, value) : value;
        if (!["set", "next", "file"].includes(verb)) throw new Error("Use /rubric set|next|file|show|clear|model|max-iterations|grade");
        await client.setRubric(text.split(/\n|\|/u).map((line) => line.replace(/^\s*[-*]\s+/u, "").trim()).filter(Boolean), verb === "next" ? "next" : "session");
        show((await client.controls()).rubric); return;
      }
      if (["pause", "resume", "blocked", "complete"].includes(verb)) {
        await client.updateGoal(goalUpdateSchema.parse({ status: ({ pause: "paused", resume: "active" } as Record<string, string>)[verb] ?? verb, note: value || `User requested ${verb}.` }));
      } else if (verb === "set" && value.includes("|")) {
        const [objective = "", ...criteria] = value.split("|").map((item) => item.trim());
        await client.setGoal(objective, criteria);
      } else {
        const result = await client.goalWork("goal", verb === "amend" ? "amend" : "draft", ["set", "amend"].includes(verb) ? value : argument);
        if (!result.proposal) throw new Error("No goal proposal was returned");
        const proposal = result.proposal;
        const accept = async () => { await client.setGoal(proposal.objective, proposal.criteria, result.revision); print("\nGoal accepted. Tool approvals remain unchanged.\n"); };
        if ((await client.status()).mode === "auto" && (await client.configure()).settings.autoAcceptCriteria === true) await accept();
        else ui.confirm("Review goal before accepting", `${proposal.objective}\n\nAcceptance criteria:\n${proposal.criteria.map((item) => `- ${item}`).join("\n")}\n\nThis does not authorize tools or mark work complete.`, accept);
        return;
      }
      show((await client.controls()).goal); return;
    }
    case "mcp": {
      const [action, server] = argument.split(/\s+/u);
      if (action === "reconnect") show(await client.integrations("reload"));
      else if (action === "enable" || action === "disable") show(await client.integrations(action, server));
      else if (argument) throw new Error("Use /mcp reconnect, enable <server>, or disable <server>. OAuth login is not implemented.");
      else show(await client.inventory());
      return;
    }
    case "install": case "uninstall": {
      const { pluginCommand } = await import("./plugin-commands.js");
      if (!argument) { print("Optional TypeScript integrations are distributed as native plugins. Use /plugins marketplace add <manifest>, then /install <name@marketplace>. Python package extras are not installed by this port.\n"); return; }
      await pluginCommand(`${name} ${argument}`, ui); return;
    }
    case "auto-update": {
      if (!argument) { show({ enabled: (await client.configure()).settings.autoUpdate ?? true, behavior: "Verified npm installations update before session startup after a first-launch notice; development installations never self-update." }); return; }
      if (!["on", "off"].includes(argument)) throw new Error("Use /auto-update [on|off]");
      show(await client.settings({ autoUpdate: argument === "on" }, "user")); return;
    }
    case "update": {
      if (argument && argument !== "check") throw new Error("Use /update or /update check");
      const { ApplicationUpdates } = await import("../cli/updates.js");
      const result = await new ApplicationUpdates((await client.configure()).settings).check();
      show(result);
      const plan = result.plan;
      if (!plan || argument === "check") return;
      ui.confirm("Update and exit", `Install ${plan.package}@${plan.version} using npm without lifecycle scripts? This drains the server and exits. Restart the application afterward.`, async () => {
        if (!ui.installUpdate) throw new Error("This client cannot install updates; use the update CLI after exiting");
        await ui.installUpdate(plan);
      });
      return;
    }
    case "plugins": { const { pluginCommand } = await import("./plugin-commands.js"); await pluginCommand(argument, ui); return; }
    case "tools": case "extensions": show(await client.inventory()); return;
    case "theme":
      if (argument) show(await client.settings({ theme: argument }));
      else ui.pick("Terminal theme", ["dark", "light", "plain"].map((value) => ({ value, label: value })), async (theme) => { await client.settings({ theme }); });
      return;
    case "timestamps": case "line-numbers": case "scrollbar": {
      const key = name === "line-numbers" ? "lineNumbers" : name;
      const settings = (await client.configure()).settings;
      const enabled = argument ? argument === "on" ? true : argument === "off" ? false : undefined : !settings[key];
      if (enabled === undefined) throw new Error(`Use /${name} [on|off]`);
      show(await client.settings({ [key]: enabled })); return;
    }
    default: throw new Error("Unknown command. Use /help.");
  }
}
