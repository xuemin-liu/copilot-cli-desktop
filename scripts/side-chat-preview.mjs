// Local browser fixture: real renderer/xterm, in-memory IPC and no CLI.
// Run after `pnpm build`; never included in the packaged application.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const built = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { App } from './src/renderer/App.tsx';
      import { createTab, closeTab, activateTab, renameTab, EMPTY_TABS_STATE } from './src/main/session-tab-machine.ts';
      import { DEFAULT_SESSION_LAUNCH_CONFIG } from './src/main/session-launch.ts';
      const profile = {id:'preview', name:'Side chat preview', path:'C:\\\\preview', permissionPreset:'default', defaultResumeMode:'new', launch:DEFAULT_SESSION_LAUNCH_CONFIG, tabs:[]};
      const fields = {workspaceProfileId:profile.id, launchedPermissionPreset:'default', permissionWarning:null, remote:false, canFork:true};
      let tabs = createTab(EMPTY_TABS_STATE, {...fields,id:'main',title:'Main discussion',lastSessionId:'11111111-1111-4111-8111-111111111111'});
      tabs = createTab(tabs,{...fields,id:'other',title:'Other work'});
      tabs = activateTab(tabs,'main');
      let sequence=0;
      const listeners=new Set(), outputs=new Set();
      const snapshot=()=>({desktopVersion:'UI fixture',resolution:{kind:'direct',command:'copilot',prefixArgs:[],resolvedPath:'copilot',version:'1.0.82',error:null},profiles:[profile],activeProfileId:profile.id,...tabs,tabs:tabs.tabs.map(tab=>({...tab,status:'running',processId:42})),maxSessionTabs:20,recentLogs:[],error:null});
      const update=()=>{const state=snapshot();for(const listener of listeners)listener(state);return Promise.resolve(state)};
      window.copilotDesktop={
        getState:async()=>snapshot(),
        onStateChanged:(listener)=>{listeners.add(listener);return()=>listeners.delete(listener)},
        onTabOutput:(listener)=>{outputs.add(listener);return()=>outputs.delete(listener)},
        onTabExit:()=>()=>{},
        activateTab:(id)=>{tabs=activateTab(tabs,id);return update()},
        closeTab:(id)=>{tabs=closeTab(tabs,id);return update()},
        renameTab:(id,title)=>{tabs=renameTab(tabs,id,title);return update()},
        restartTab:async()=>snapshot(),
        forkSideChat:(id,sourceSessionId,title)=>{tabs=createTab(tabs,{...fields,id:'side-'+ ++sequence,title,sideChat:true,sideParentTabId:id,launchedPermissionPreset:'read-only',canFork:false});return update()},
        createTab:()=>{tabs=createTab(tabs,{...fields,id:'new-'+ ++sequence,title:'New work'});return update()},
        getTabBacklog:async(id)=>'\\x1b[32m'+(id.startsWith('side')?'Forked context — separate conversation':'Original conversation — still running')+'\\x1b[0m\\r\\n> ',
        writeTab:async(id,data)=>{for(const listener of outputs)listener({tabId:id,data})},
        resizeTab:async()=>{},openSettings:async()=>{},readClipboardText:async()=>'',copyText:async()=>{},showTerminalContextMenu:async()=>{},
      };
      createRoot(document.getElementById('root')).render(<App/>);
    `,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, platform: 'browser', write: false, jsx: 'automatic',
})
const bundle = built.outputFiles[0].contents
const files = new Map([
  ['/app.js', { type: 'text/javascript', body: bundle }],
  ['/styles.css', { type: 'text/css', body: await readFile('src/renderer/styles.css') }],
  ['/xterm.css', { type: 'text/css', body: await readFile('dist/src/renderer/xterm.css') }],
  ['/', { type: 'text/html', body: await readFile('src/renderer/index.html') }],
])
const server = createServer((request, response) => {
  const file = files.get(request.url)
  response.writeHead(file ? 200 : 404, { 'Content-Type': file?.type ?? 'text/plain' })
  response.end(file?.body ?? 'Not found')
})
server.listen(4318, '127.0.0.1', () => console.log('Side-chat renderer fixture: http://127.0.0.1:4318'))
