/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: {
    command: "node --test test/validation.test.mjs test/platform-launch.test.mjs test/inbox-fuzz.test.mjs",
  },
  mutate: [
    "lib/security.js",
    "lib/sessions.js",
    "lib/tasks.js",
  ],
  reporters: ["clear-text", "html"],
  coverageAnalysis: "off",
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
};
