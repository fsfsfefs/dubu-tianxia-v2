import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('factory WebView compatibility supports PDF promises and abort reasons',async()=>{
 class OldPromise extends Promise {}
 Object.defineProperty(OldPromise,'withResolvers',{value:undefined,configurable:true});
 function OldSignal() {}
 OldSignal.prototype=AbortSignal.prototype;
 class OldStream extends ReadableStream {}
 Object.defineProperty(OldStream.prototype,'values',{value:undefined,configurable:true});
 Object.defineProperty(OldStream.prototype,Symbol.asyncIterator,{value:undefined,configurable:true});
 const scope={Promise:OldPromise,AbortSignal:OldSignal,AbortController,Event,ReadableStream:OldStream};
 const code=readFileSync(new URL('../.tmp/tests/androidCompatibility.js',import.meta.url),'utf8').replace('export function','function');
 vm.runInNewContext(code+';installAndroidCompatibility();',scope);
 const first=OldPromise.withResolvers();first.resolve('pdf');assert.equal(await first.promise,'pdf');
 const second=OldPromise.withResolvers();second.reject(new Error('cancel'));await assert.rejects(second.promise,/cancel/);
 const a=new AbortController(),b=new AbortController();const merged=OldSignal.any([a.signal,b.signal]);
 assert.equal(merged.aborted,false);b.abort('stop');assert.equal(merged.reason,'stop');
 assert.equal(OldSignal.any([b.signal]).reason,'stop');
 assert.equal(OldSignal.any([]).aborted,false);
 const stream=new OldStream({start(c){c.enqueue('PDF');c.enqueue('text');c.close();}});
 const parts=[];for await(const part of stream)parts.push(part);assert.deepEqual(parts,['PDF','text']);assert.equal(stream.locked,false);
 let cancelled=false;const pending=new OldStream({start(c){c.enqueue('first');},cancel(){cancelled=true;}});
 for await(const part of pending){assert.equal(part,'first');break;}
 assert.equal(cancelled,true);assert.equal(pending.locked,false);
});
