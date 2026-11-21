// Loaded only from TABS' private OpenCode location. No service credentials,
// imports, global config, filesystem reads or persistent bridge secrets.
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const rpc = {
  id: 'tabs.bridge',
  events: {},
  methods: {
    configure: {
      errors: {},
      input: object({ endpoint: { type: 'string' }, token: { type: 'string' } }, ['endpoint', 'token']),
      output: object({ ready: { type: 'boolean' } }, ['ready']),
    },
    bind: {
      errors: {},
      input: object({ sessionID: { type: 'string' }, admissionID: { type: 'string' }, tools: { type: 'array', items: { type: 'object' } } }, ['sessionID', 'admissionID', 'tools']),
      output: object({ ready: { type: 'boolean' } }, ['ready']),
    },
  },
};

export default {
  id: 'tabs.business',
  async setup(ctx) {
    let connection;
    const bindings = new Map();
    const definitions = new Map();
    const relay = async (body, signal) => {
      if (!connection) throw new Error('TABS bridge is disconnected');
      const response = await fetch(connection.endpoint + '/call', {
        method: 'POST', signal,
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('TABS tool request was rejected or cancelled');
      return response.json();
    };
    const tools = await ctx.tool.transform((editor) => {
      for (const spec of definitions.values()) {
        editor.add({
          name: spec.name, description: spec.description, input: spec.inputSchema,
          options: { codemode: false },
          execute: async (input, context) => {
            const binding = bindings.get(context.sessionID);
            if (!binding || !binding.tools.some((tool) => tool.name === spec.name)) {
              throw new Error('Tool is outside the captured TABS context');
            }
            const body = { sessionId: context.sessionID, admissionId: binding.admissionID,
              messageId: context.messageID, callId: context.id, toolName: spec.name, input };
            const prepared = await relay({ ...body, stage: 'prepare' }, context.signal);
            if (!spec.name.endsWith('_read_v1') && !spec.name.endsWith('_list_v1')) {
              // Let the session resolve its agent and session-scoped rules;
              // do not supply a separate executor agent override.
              await ctx.permission.assert({ sessionID: context.sessionID,
                source: { type: 'tool', messageID: context.messageID, id: context.id },
                action: 'tabs.mutate', resources: [spec.name], save: [],
                metadata: { summary: prepared.summary },
              });
            }
            const result = await relay({ ...body, stage: 'execute' }, context.signal);
            return { content: result.text };
          },
        });
      }
    });
    const registration = await ctx.rpc.register(rpc, {
      configure: async (input) => {
        const endpoint = new URL(input.endpoint);
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
          || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('Invalid TABS endpoint');
        if (connection?.endpoint !== endpoint.origin || connection?.token !== input.token) bindings.clear();
        connection = { endpoint: endpoint.origin, token: input.token };
        return { ready: true };
      },
      bind: async (input) => {
        if (!connection || !input.admissionID.startsWith('msg_')) throw new Error('TABS is not connected');
        const session = await ctx.session.get({ sessionID: input.sessionID });
        if (!session.metadata?.tabsThreadID || session.location.directory.replaceAll('\\', '/').toLowerCase()
          !== ctx.location.directory.replaceAll('\\', '/').toLowerCase()) throw new Error('Foreign session');
        bindings.set(input.sessionID, input);
        for (const tool of input.tools) definitions.set(tool.name, tool);
        await ctx.tool.reload();
        return { ready: true };
      },
    });
    const hook = await ctx.session.hook('context', (event) => {
      const binding = bindings.get(event.sessionID);
      const allowed = new Set(binding?.tools.map((tool) => tool.name) ?? []);
      for (const name of Object.keys(event.tools)) {
        if (name.startsWith('tabs_') && !allowed.has(name)) delete event.tools[name];
      }
    });
    return async () => {
      connection = undefined;
      bindings.clear();
      await hook.dispose();
      await registration.dispose();
      await tools.dispose();
    };
  },
};
