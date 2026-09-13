import { describe, expect, test } from "bun:test";
import { compileCodeModeHelperInput } from "../../src/responses/code-mode-helper-compat";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

describe("code-mode helper compatibility", () => {
  test("exec_command arguments remain data when generated JavaScript runs", async () => {
    const command = "printf '%s' \"$HOME\"; }); throw new Error('escaped') //";
    const source = compileCodeModeHelperInput(
      JSON.stringify({ cmd: command, workdir: "/tmp", yield_time_ms: 1_000 }),
      "exec_command",
    );
    let received: unknown;
    let output: unknown;
    const run = new AsyncFunction("tools", "text", source);

    await run({
      exec_command: async (args: unknown) => {
        received = args;
        return { exit_code: 0, output: "ok" };
      },
    }, (value: unknown) => { output = value; });

    expect(received).toEqual({ cmd: command, workdir: "/tmp", yield_time_ms: 1_000 });
    expect(output).toEqual({ exit_code: 0, output: "ok" });
  });

  test("shell_command maps command to the nested exec cmd field", async () => {
    const source = compileCodeModeHelperInput(
      JSON.stringify({ command: "pwd", workdir: "/tmp" }),
      "shell_command",
    );
    let received: unknown;
    const run = new AsyncFunction("tools", "text", source);
    await run({
      exec_command: async (args: unknown) => {
        received = args;
        return "ok";
      },
    }, () => {});
    expect(received).toEqual({ workdir: "/tmp", cmd: "pwd" });
  });

  test("write_stdin arguments remain data and target the nested helper", async () => {
    const args = {
      session_id: 17,
      chars: "`); throw new Error('escaped') //",
      yield_time_ms: 1_000,
    };
    const source = compileCodeModeHelperInput(JSON.stringify(args), "write_stdin");
    let received: unknown;
    let output: unknown;
    const run = new AsyncFunction("tools", "text", source);

    await run({
      write_stdin: async (value: unknown) => {
        received = value;
        return { output: "more" };
      },
    }, (value: unknown) => { output = value; });

    expect(received).toEqual(args);
    expect(output).toEqual({ output: "more" });
  });

  test("apply_patch text remains one string argument", async () => {
    const patch = "*** Begin Patch\n*** Add File: note.txt\n+`); throw new Error('escaped')\n*** End Patch";
    const source = compileCodeModeHelperInput(patch, "apply_patch");
    let received: unknown;
    const run = new AsyncFunction("tools", "text", source);
    await run({
      apply_patch: async (input: unknown) => {
        received = input;
        return "done";
      },
    }, () => {});
    expect(received).toBe(patch);
  });

  test("apply_patch normalizes decorated outer delimiters before execution", async () => {
    const decorated = "*** Begin Patch ***\n*** Add File: note.txt\n+hello\n*** End Patch ***";
    const canonical = "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch";
    let received: unknown;
    const run = new AsyncFunction(
      "tools",
      "text",
      compileCodeModeHelperInput(JSON.stringify({ input: decorated }), "apply_patch"),
    );

    await run({
      apply_patch: async (input: unknown) => {
        received = input;
        return "done";
      },
    }, () => {});

    expect(received).toBe(canonical);
  });

  test("invalid structured shell input remains data instead of becoming JavaScript", async () => {
    for (const input of ["{not-json", "[]"]) {
      let received: unknown;
      const run = new AsyncFunction("tools", "text", compileCodeModeHelperInput(input, "exec_command"));
      await run({
        exec_command: async (args: unknown) => {
          received = args;
          return "rejected";
        },
      }, () => {});
      expect(received).toEqual(input === "[]" ? [] : input);
    }
  });
});

for (const name of ["view_image", "default.view_image"]) {
  test(`${name} emits image data and preserves arguments`, async () => {
    const args = { path: "/tmp/'); throw new Error('escaped') //", detail: "original" };
    const result = { image_url: "data:image/png;base64,fixture", detail: "original" };
    let received: unknown;
    let emitted: unknown[] = [];
    const run = new AsyncFunction("tools", "image", compileCodeModeHelperInput(JSON.stringify(args), name));
    await run({ view_image: async (value: unknown) => { received = value; return result; } },
      (...values: unknown[]) => { emitted = values; });
    expect(received).toEqual(args);
    expect(emitted).toEqual([result.image_url, "original"]);
  });
}

for (const helper of ["exec_command", "shell_command", "write_stdin", "apply_patch"]) {
  test(`default.${helper} keeps the existing helper compiler`, () => {
    const args = helper === "apply_patch" ? "*** Begin Patch\n*** End Patch" : '{"command":"pwd","session_id":17}';
    expect(compileCodeModeHelperInput(args, `default.${helper}`)).toBe(compileCodeModeHelperInput(args, helper));
  });
}

for (const input of ['not-json', '[]', 'null', '{"path":"/tmp/chart.png"}']) {
  test(`image helper passes invalid or optional arguments to the nested validator: ${input}`, async () => {
    let received: unknown;
    let expected: unknown = input;
    try { expected = JSON.parse(input); } catch {}
    const run = new AsyncFunction("tools", "image", compileCodeModeHelperInput(input, "view_image"));
    await expect(run({ view_image: async (value: unknown) => { received = value; throw new Error("fixture validation"); } },
      () => { throw new Error("unexpected image output"); })).rejects.toThrow("fixture validation");
    expect(received).toEqual(expected);
  });
}
