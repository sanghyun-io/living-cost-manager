import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
const actual=new URL('../buildx-client.mjs',import.meta.url).href;
const replacement=readFileSync(new URL('./overlay-cli-client.mjs',import.meta.url),'utf8');
registerHooks({load(url,context,next){return url===actual?{format:'module',source:replacement,shortCircuit:true}:next(url,context);}});
