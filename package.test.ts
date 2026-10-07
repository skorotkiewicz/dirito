import { test, expect } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Keep packaging checks away from the working tree and never contact a publish endpoint.
test("npm tarball installs cleanly and runs through bunx from another directory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "dirito-package-"));
  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  async function command(args: string[], cwd = import.meta.dir) {
    const result = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
    if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}):\n${stdout}\n${stderr}`);
    return stdout;
  }
  const manifest = await Bun.file(join(import.meta.dir, "package.json")).json();
  const archive = join(scratch, `${manifest.name}-${manifest.version}.tgz`);
  // Skip prepack here because prepack runs this test itself.
  await command([process.execPath, "pm", "pack", "--destination", scratch, "--ignore-scripts"]);
  const files = (await command(["tar", "-tzf", archive])).trim().split("\n").sort();
  const expected = ["package/README.md", "package/editor.ts", "package/index.ts", "package/package.json", "package/resize.ts", "package/workspace.css", "package/workspace.html", "package/workspace.ts"];
  if (await Bun.file(join(import.meta.dir, "LICENSE")).exists()) expected.push("package/LICENSE");
  expect(files).toEqual(expected.sort());
  await Bun.write(join(consumer, "package.json"), JSON.stringify({ name: "package-smoke", private: true, dependencies: { "dirito": archive } }));
  await command([process.execPath, "install", "--production", "--ignore-scripts"], consumer);
  expect(await Bun.file(join(consumer, "node_modules/typescript/package.json")).exists()).toBe(false);
  const installed = await Bun.file(join(consumer, "node_modules/dirito/package.json")).json();
  expect(installed.bin["dirito"]).toBe("./index.ts");
  expect(installed.peerDependencies).toBeUndefined();
  await mkdir(join(consumer, "project"));
  await Bun.write(join(consumer, "project/index.html"), "<!doctype html><h1>Packed preview</h1>");
  expect(await command([process.execPath, "x", "--no-install", "dirito", "--help"], consumer)).toContain("Usage: dirito");
  const cli = Bun.spawn([process.execPath, "x", "--no-install", "dirito", "project/", "--watch", "--no-open", "--port", "0"], { cwd: consumer, stdout: "pipe", stderr: "pipe" });
  const bootTimeout = setTimeout(() => cli.kill(), 15000);
  try {
    let output = "";
    const decoder = new TextDecoder();
    for await (const chunk of cli.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (/Workspace\s+http:\/\/[^\s]+/.test(output)) break;
    }
    clearTimeout(bootTimeout);
    const address = output.match(/Workspace\s+(http:\/\/[^\s]+)/)?.[1];
    if (!address) throw new Error(`CLI did not start: ${output}\n${await new Response(cli.stderr).text()}`);
    const url = new URL(address);
    const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
    const state = await (await fetch(`${url.origin}/api/state`, { headers: auth, signal: AbortSignal.timeout(5000) })).json();
    expect(state.root).toBe(join(consumer, "project"));
    expect(state.watch).toBe(true);
    const html = await (await fetch(url.origin)).text();
    expect(html).toContain("File manager");
    for (const asset of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
      const response = await fetch(new URL(asset[1]!, url.origin));
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    expect(await (await fetch(state.preview)).text()).toContain("Packed preview");
  } finally {
    clearTimeout(bootTimeout);
    cli.kill();
    await cli.exited;
  }
}, 60000);
