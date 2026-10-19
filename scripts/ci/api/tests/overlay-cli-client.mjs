// Test-only dependency double loaded with Node's standard module hooks. The CLI,
// controller, lease, transfer, hashing and phase handlers remain the actual code.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export function privateClient(dir,{home}={}) {
 const prefix=['--config',dir,'--context','colima'];
 const env={...process.env,DOCKER_HOST:`unix://${home}/.colima/default/docker.sock`,DOCKER_CONFIG:dir};delete env.DOCKER_CONTEXT;
 const call=args=>{const r=spawnSync('docker',[...prefix,...args],{env,encoding:'utf8',timeout:5000});if(r.status!==0)throw Error('fixture-cli-command');return r.stdout.trim();};
 if(call(['context','inspect','colima','--format','{{.Endpoints.docker.Host}}'])!==env.DOCKER_HOST)throw Error('fixture-private-endpoint');
 const {nativeGcReserve}=JSON.parse(readFileSync(join(process.env.LCM_CLI_FIXTURE,'control.json'),'utf8'));
 return {dir,prefix,env,call,backend:'fixture-native-Buildx',nativeGcReserve};
}
