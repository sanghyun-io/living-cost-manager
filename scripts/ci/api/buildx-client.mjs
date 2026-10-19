import {readFileSync,writeFileSync,mkdirSync,symlinkSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';
export const TOOL=Object.freeze({path:'/opt/homebrew/opt/docker-buildx/bin/docker-buildx',version:'0.38.0',sha256:'cad958b66cf6a0ade495bb9560341509dd8747e61345ba14303207f9bac2d9a3',bottleSha256:'4accfcfd6ebc0f7ef47db24b93447bd5e1751cc74b2e1874e8f2e11b0e02d806'});
export function privateClient(dir,{home,create=false,tool=TOOL,run}={}) {
 if(!home||!dir.startsWith(home+'/')||/[\r\n]/.test(dir))throw Error('private-client-path');
 if(create){if(existsSync(dir))throw Error('private-client-preexisting');mkdirSync(dir,{mode:0o700});mkdirSync(join(dir,'cli-plugins'),{mode:0o700});symlinkSync(tool.path,join(dir,'cli-plugins/docker-buildx'));writeFileSync(join(dir,'config.json'),'{"currentContext":"colima"}\n',{mode:0o600});}
 const cfg=lstatSync(dir);if(cfg.isSymbolicLink()||realpathSync(dir)!==dir||cfg.uid!==process.getuid()||(cfg.mode&0o777)!==0o700)throw Error('private-client-owner');
 if(JSON.stringify(JSON.parse(readFileSync(join(dir,'config.json'),'utf8')))!=='{"currentContext":"colima"}')throw Error('private-client-config');
 if(createHash('sha256').update(readFileSync(realpathSync(join(dir,'cli-plugins/docker-buildx')))).digest('hex')!==tool.sha256)throw Error('buildx-binary-pin');
 const endpoint=`unix://${home}/.colima/default/docker.sock`,env={...process.env,DOCKER_HOST:endpoint,DOCKER_CONFIG:dir};delete env.DOCKER_CONTEXT;
 const prefix=['--config',dir,'--context','colima'];
 function call(args){if(run)return run('docker',[...prefix,...args],{env});const r=spawnSync('docker',[...prefix,...args],{env,encoding:'utf8',timeout:10000});if(r.status!==0)throw Error('private-client-command');return r.stdout.trim();}
 if(create)call(['context','create','colima','--docker',`host=${endpoint}`]);
 if(call(['context','inspect','colima','--format','{{.Endpoints.docker.Host}}'])!==endpoint)throw Error('private-context-endpoint');
 if(!call(['buildx','version']).includes(`v${tool.version} `))throw Error('buildx-version');
 const inspect=call(['buildx','inspect','default']);if(!/^Driver:\s+docker\s*$/m.test(inspect)||!/^Status:\s+running\s*$/m.test(inspect)||!/^Endpoint:\s+default\s*$/m.test(inspect))throw Error('builder-not-native-default');
 // Avoid inducing the existing shared daemon's automatic cache GC. This is
 // observed daemon metadata, NOT a new daemon configuration or global policy.
 const gc=[...inspect.matchAll(/Min Free Space:\s+([0-9.]+)(GiB|MiB)/g)].map(m=>(+m[1]+.001)*(m[2]==='GiB'?1024**3:1024**2));
 if(!gc.length)throw Error('native-gc-headroom-unknown');
 const nativeGcReserve=Math.ceil(Math.max(...gc)+128*1024**2);
 return {dir,prefix,env,call,backend:call(['buildx','version']),builderInspection:inspect,nativeGcReserve};
}
