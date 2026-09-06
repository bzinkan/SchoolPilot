import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','4188','--strictPort'],{cwd:root,windowsHide:true,stdio:'pipe'});
try{
  let ready=false;
  for(let attempt=0;attempt<150;attempt++){
    if(server.exitCode!==null)throw new Error(`Vite exited with ${server.exitCode}`);
    try{if((await fetch('http://127.0.0.1:4188/browsing-history-regression.html')).ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(!ready)throw new Error('History browser fixture did not become ready.');
  const child=spawn(process.execPath,['scripts/browsing-history-browser.mjs'],{cwd:root,windowsHide:true,stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)process.exitCode=typeof code==='number'?code:1;
}finally{server.kill();}
