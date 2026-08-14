"""Generate the static fallback icons in public/ (favicon.ico, apple-touch-icon.png).

These are only the pre-paint fallback and the answer to a bare /favicon.ico request:
the icon you actually see comes from Settings > Appearance and is generated in the
browser as a data URL. This script keeps that fallback in sync with the default
glyph, and has no dependencies, so `python3 scripts/make-icons.py` just works.

It rasterises the same shapes as the "prompt" glyph by supersampled point-in-shape
tests, rather than parsing SVG, which is why the geometry is repeated here.
"""

import struct, zlib, math

TILE=(0xd9,0x59,0x26); MARK=(255,255,255)

def rrect_in(x,y,x0,y0,x1,y1,r):
    cx=min(max(x,x0+r),x1-r); cy=min(max(y,y0+r),y1-r)
    if x0<=x<=x1 and y0<=y<=y1:
        return (x-cx)**2+(y-cy)**2 <= r*r or (x0+r<=x<=x1-r) or (y0+r<=y<=y1-r)
    return False

def seg_d(px,py,ax,ay,bx,by):
    dx,dy=bx-ax,by-ay; t=((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)
    t=max(0.0,min(1.0,t)); return math.hypot(px-(ax+t*dx),py-(ay+t*dy))

def mark_in(x,y):
    if seg_d(x,y,10,10.5,15.5,16)<=1.7 or seg_d(x,y,15.5,16,10,21.5)<=1.7: return True
    return rrect_in(x,y,17.6,19.8,26.0,23.0,1.6)

def render(n,ss=4):
    px=bytearray(); s=32.0/n
    for j in range(n):
        px.append(0)
        for i in range(n):
            tin=min=0; tot=ss*ss; ti=0; mi=0
            for sy in range(ss):
                for sx in range(ss):
                    x=(i+(sx+0.5)/ss)*s; y=(j+(sy+0.5)/ss)*s
                    if rrect_in(x,y,0,0,32,32,7):
                        ti+=1
                        if mark_in(x,y): mi+=1
            a=ti/tot; m=(mi/ti) if ti else 0
            col=[round(TILE[k]*(1-m)+MARK[k]*m) for k in range(3)]
            px += bytes(col)+bytes([round(a*255)])
    return bytes(px)

def png(n):
    raw=render(n)
    def chunk(t,d):
        c=t+d; return struct.pack(">I",len(d))+c+struct.pack(">I",zlib.crc32(c)&0xffffffff)
    return (b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",n,n,8,6,0,0,0))
            +chunk(b"IDAT",zlib.compress(raw,9))+chunk(b"IEND",b""))

sizes=[16,32,48,64,128,180,256]
imgs={n:png(n) for n in sizes}
open("public/apple-touch-icon.png","wb").write(imgs[180])
open("public/favicon-32.png","wb").write(imgs[32])
ico=[16,32,48]
hdr=struct.pack("<HHH",0,1,len(ico)); off=6+16*len(ico); ent=b""; body=b""
for n in ico:
    d=imgs[n]
    ent+=struct.pack("<BBBBHHII",n if n<256 else 0,n if n<256 else 0,0,0,1,32,len(d),off)
    off+=len(d); body+=d
open("public/favicon.ico","wb").write(hdr+ent+body)
print("ok", {n:len(imgs[n]) for n in ico})
