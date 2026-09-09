import type { Metadata } from 'next';
import {headers} from 'next/headers';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
const geistSans=Geist({variable:'--font-geist-sans',subsets:['latin']});
const geistMono=Geist_Mono({variable:'--font-geist-mono',subsets:['latin']});
export async function generateMetadata():Promise<Metadata>{const h=await headers();const host=h.get('x-forwarded-host')||h.get('host')||'localhost:3002';const protocol=h.get('x-forwarded-proto')||(host.includes('localhost')?'http':'https');const title='Rogue Squadron — The Battle of Yavin';const description='One squadron. One impossible shot. A cinematic, playable journey into the Death Star trench.';const image=protocol+'://'+host+'/og.png';return {title,description,icons:{icon:'/favicon.svg'},openGraph:{title,description,images:[image],type:'website'},twitter:{card:'summary_large_image',title,description,images:[image]}}}
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>}
