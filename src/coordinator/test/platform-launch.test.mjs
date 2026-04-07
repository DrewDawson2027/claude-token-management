import test from "node:test";
import assert from "node:assert/strict";

const { __test__ } = await import(`../index.js?platform-launch=${Date.now()}`);

test("darwin iTerm2 split launches the bootstrap as the profile command", () => {
  const rendered = __test__
    .buildItermProfileCommandLaunchScript("echo hello", "split")
    .join("\n");
  assert.match(
    rendered,
    /set newSession to \(split vertically with default profile command "echo hello"\)/,
  );
  assert.doesNotMatch(rendered, /write text/i);
  assert.match(rendered, /return "OK\\t" & newTty/);
});

test("darwin iTerm2 tab launches the bootstrap as the profile command", () => {
  const rendered = __test__
    .buildItermProfileCommandLaunchScript("echo hello", "tab")
    .join("\n");
  assert.match(
    rendered,
    /set newTab to \(create tab with default profile command "echo hello"\)/,
  );
  assert.doesNotMatch(rendered, /write text/i);
  assert.match(rendered, /return "OK\\t" & newTty/);
});

test("darwin iTerm2 dedicated smoke window isolates visible worker runs", () => {
  const rendered = __test__
    .buildItermProfileCommandLaunchScript("echo hello", "split", {
      dedicatedWindow: true,
    })
    .join("\n");
  assert.match(
    rendered,
    /set newWindow to \(create window with default profile command "echo hello"\)/,
  );
  assert.doesNotMatch(rendered, /split vertically/i);
  assert.doesNotMatch(rendered, /write text/i);
});
