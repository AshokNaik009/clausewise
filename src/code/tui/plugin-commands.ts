import { resolve } from "node:path";
import type { CommandUi } from "./commands.js";

export async function pluginCommand(argument: string, ui: CommandUi): Promise<void> {
  const [action = "", ...words] = argument.trim().split(/\s+/u);
  const value = words.join(" ");
  const show = (result: unknown) => ui.print(`\n${JSON.stringify(result, null, 2)}\n`);
  if (!action || action === "list") { show(await ui.client.plugins("list")); return; }
  if (action === "reload") { show(await ui.client.integrations("reload")); return; }
  if (action === "marketplace" && words[0] === "add" && words.length > 1) {
    const source = words.slice(1).join(" ");
    const path = source.startsWith("https://") ? source : resolve(ui.client.session.cwd, source);
    ui.confirm("Register plugin marketplace", `Read the marketplace at ${path}? Remote sources make an explicit network request. No plugin code is executed by registration.`, async () => { show(await ui.client.plugins("marketplace-add", path)); });
    return;
  }
  if (["install", "update"].includes(action) && value) {
    const preview = await ui.client.pluginPreview(value);
    ui.confirm("Review plugin installation", `${preview.id} ${preview.manifest.version}\nSource to review: ${preview.source}\nSHA-256: ${preview.digest}\n${JSON.stringify(preview.manifest, null, 2)}\n\nInstalling preserves existing snapshots. New installations are disabled until enabled. Enabled updates execute on reload with your privileges.`, async () => {
      show(await ui.client.plugins("install", value, preview.digest));
      show(await ui.client.integrations("reload"));
    });
    return;
  }
  if (["enable", "disable", "uninstall"].includes(action) && value) {
    const operation = action as "enable" | "disable" | "uninstall";
    ui.confirm(`${action} plugin`, `${value}\nEnabling executes trusted extension code on reload. Disabling or uninstalling removes active registrations after a successful reload. Uninstall preserves cached snapshots and plugin data.`, async () => {
      show(await ui.client.plugins(operation, value));
      try { show(await ui.client.integrations("reload")); }
      catch (error) { ui.print("Plugin registry changed, but runtime reload failed. Restart before using any tools; the previous runtime may still be active.\n"); throw error; }
    });
    return;
  }
  throw new Error("Use /plugins list|marketplace add <manifest>|install <name@marketplace>|update <name@marketplace>|enable <id>|disable <id>|uninstall <id>|reload");
}
