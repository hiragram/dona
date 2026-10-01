// 通常Updaterのmain lifecycle adapterを使う保守経路。worker操作やsession一括操作はしない。
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function mainArguments(args, policy, mcpRoot = policy.config_root) {
  if (!(args[2] === 'agent' && args[3] === 'start')) return args;
  if (args[0] !== '--session' || args[1] !== 'dona' || args[4] !== 'dona-main') throw Error('main_scope');
  const extra = [];
  for (const [server, file] of [['dona_dispatcher', 'dispatcher'], ['dona_slack', 'slack']]) {
    for (const [key, value] of Object.entries({command:policy.executables.node,
      args:[path.join(mcpRoot, `mcp-${file}.mjs`)], cwd:policy.config_root, required:true, enabled:true})) {
      extra.push('-c', `mcp_servers.${server}.${key}=${JSON.stringify(value)}`);
    }
  }
  return [...args.slice(0, -1), ...extra, args.at(-1)];
}

export async function operate(request, policy, Runtime, Process) {
  const process = new Process();
  const runtime = new Runtime(policy, {run:(executable,args,options) =>
    process.run(executable, mainArguments(args, policy, request.mcp_root), options)});
  if (request.action === 'status') return runtime.mainAgentStatus(request.release);
  if (request.action === 'stop') return runtime.stopMainAgent(request.expected);
  if (request.action === 'start') return runtime.startMainAgent(request.pane, request.release, request.previous_session);
  throw Error('main_action');
}

export async function probe(policy) {
  const sdk=path.join(policy.current_pointer, 'dispatcher/node_modules/@modelcontextprotocol/sdk/dist/esm/client');
  const {Client}=await import(pathToFileURL(path.join(sdk,'index.js')));
  const {StdioClientTransport}=await import(pathToFileURL(path.join(sdk,'stdio.js')));
  const results=[];
  for (const [name, expected] of [['dispatcher','delegate_job'],['slack','post_message']]) {
    const transport=new StdioClientTransport({command:policy.executables.node,
      args:[path.join(policy.config_root,`mcp-${name}.mjs`)],stderr:'pipe'});
    // stderrに認証情報やworkspace名が含まれ得るため転記しない。
    transport.stderr?.on('data',()=>{});
    const client=new Client({name:'dona-maintenance-readiness',version:'1.0'});
    try {
      await client.connect(transport);
      const listing=await client.listTools();
      if (!listing.tools.some(tool=>tool.name===expected)) throw Error('mcp_tools_missing');
      results.push({server:name,initialized:true,tool_count:listing.tools.length});
    } finally { await client.close(); }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    const root = path.resolve(process.argv[2]);
    const {loadPolicy} = await import(pathToFileURL(path.join(root, 'updater/dist/policy.js')));
    const {RealRuntime} = await import(pathToFileURL(path.join(root, 'updater/dist/adapters.js')));
    const {ProcessRunner} = await import(pathToFileURL(path.join(root, 'updater/dist/process.js')));
    const policy = loadPolicy(path.join(root, 'policy.json'));
    console.log(JSON.stringify(request.action === 'probe' ? await probe(policy) : await operate(request, policy, RealRuntime, ProcessRunner)));
  } catch {
    // adapter stderr、環境設定、認証情報を親のログへ転記しない。
    console.error('main_lifecycle_bridge_failed');
    process.exitCode = 1;
  }
}
