import {build} from 'esbuild';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const result=await build({stdin:{contents:"import {createElement} from 'react';import {createRoot} from 'react-dom/client';import Home from './app/page';createRoot(document.getElementById('root')).render(createElement(Home));",resolveDir:root,sourcefile:'local-entry.tsx',loader:'tsx'},bundle:true,format:'iife',platform:'browser',target:'es2020',jsx:'automatic',minify:true,write:false,splitting:false,legalComments:'none',define:{'process.env.NODE_ENV':'"production"'}});
const cssDir=path.join(root,'dist/client/_next/static/css');
let css=(await Promise.all((await readdir(cssDir)).filter(x=>x.endsWith('.css')).map(x=>readFile(path.join(cssDir,x),'utf8')))).join('\n');
const fontRoot=path.join(root,'dist/client/_next/static/_vinext_fonts');
const fontSpecs=[['Local Geist','geist-8ac0455e797f','geist-98bbbccb.woff2'],['Local Geist Mono','geist-mono-00e989178794','geist-mono-013b2f2f.woff2']];
for(const [name,dir,file] of fontSpecs){const data=(await readFile(path.join(fontRoot,dir,file))).toString('base64');css+=`\n@font-face{font-family:'${name}';font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${data}) format('woff2');}`;}
css+='\n:root{--font-geist-sans:"Local Geist",Arial,sans-serif;--font-geist-mono:"Local Geist Mono",monospace}#root{width:100%;height:100%}';
const icon=(await readFile(path.join(root,'public/favicon.svg'))).toString('base64');
const js=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#080b0e"><meta name="description" content="One squadron. One impossible shot. A complete offline playable space cinematic."><title>Rogue Squadron — The Battle of Yavin</title><link rel="icon" href="data:image/svg+xml;base64,${icon}"><style>${css}</style></head><body><div id="root"></div><noscript>This experience requires JavaScript and a browser with WebGL2.</noscript><script>${js}</script></body></html>`;
const output=path.join(root,'rogue-squadron.html');
await writeFile(output,html);console.log(`Exported ${output} (${(Buffer.byteLength(html)/1024/1024).toFixed(2)} MB)`);
