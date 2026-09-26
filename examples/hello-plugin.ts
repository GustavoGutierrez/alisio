import { definePlugin, textResult } from "@alisio/sdk";
export default definePlugin({
  id: "example.hello",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.tools.register({
      name: "hello",
      description: "Return a friendly Caribbean greeting.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return textResult("¡Ajá! Listo para construir.");
      },
    });
    api.commands.register("hello", async () => "¡Ajá! Alisio está listo.");
  },
});
