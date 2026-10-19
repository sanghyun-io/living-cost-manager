// Stateful CLI double for the Mac shared context ONLY; never invokes Docker.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
const dir=join(process.env.FAKE_HOST,'state'),file=join(dir,'local-docker.json'),a=process.argv.slice(2),cmd=a[0];
let state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{image:{},container:{},network:{}};
const after=f=>a[a.indexOf(f)+1],last=a.at(-1),id=n=>'sha256:'+createHash('sha256').update(n).digest('hex');
const labels=()=>Object.fromEntries(a.flatMap((v,i)=>v==='--label'?[a[i+1].split(/=(.*)/s).slice(0,2)]:[]));
const done=x=>{writeFileSync(file,JSON.stringify(state));if(x!==undefined)console.log(typeof x==='string'?x:JSON.stringify(x));};
if(cmd==='context')done(`unix://${process.env.HOME}/.colima/default/docker.sock`);
else if(cmd==='version')done('linux/arm64');else if(cmd==='info')done('/var/lib/docker');
else if(cmd==='build'){const tag=after('-t');state.image[tag]={Id:id(tag),Size:660000000,Os:'linux',Architecture:'arm64',Config:{Labels:{...labels(),'moby.buildkit.cache.v0':'inline'}}};done();}
else if(['image','container','network'].includes(cmd)&&a[1]==='ls') {
 if(a.includes('--quiet'))done(Object.values(state.image).map(x=>x.Id).join('\n'));
 else {const filter=after('--filter'),name=filter?.startsWith('reference=')?filter.slice(10):filter?.replace(/^name=\^\/?/,'').replace(/\$$/,'');done(state[cmd][name]?(last==='{{.Size}}'?'641MB':name):'');}
}else if(['image','container','network'].includes(cmd)&&a[1]==='inspect'){const x=state[cmd][a[2]];if(!x)process.exit(1);done(x);}
else if(cmd==='network'&&a[1]==='create'){state.network[last]={Id:id(last),Labels:labels()};done(state.network[last].Id);}
else if(cmd==='run') {
 const name=after('--name');if(a.includes('--rm')) {
  if(a.includes('sha256sum'))done('229a1fa43233f74fef9110bf4d56307efbee93da1f8baeac3a3347588d1feb35  migration.sql');
  else if(a.join(' ').includes("grep -c '^20'"))done('12');else done();
 }else{state.container[name]={Id:id(name),Labels:labels()};done(state.container[name].Id);}
}else if(cmd==='exec') {
 if(!Object.values(state.container).some(x=>x.Id===a[1]))process.exit(1);
 if(a.includes('du'))done('20480 /var/lib/postgresql/data');else if(a.includes('node'))done({commitSha:process.env.GITHUB_SHA,releaseId:'synthetic'});else if(last==='SELECT 1')done('1');else done();
}else if(cmd==='rm'||a[1]==='rm') {const kind=cmd==='rm'?'container':cmd;for(const [k,v]of Object.entries(state[kind]))if(k===last||v.Id===last)delete state[kind][k];done();}
else if(cmd==='save'){process.stdout.write('synthetic immutable image bytes');}
else process.exit(93);
