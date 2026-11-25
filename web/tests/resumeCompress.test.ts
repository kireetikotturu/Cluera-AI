import {createCanvas} from '@napi-rs/canvas';
import {expect,it} from 'vitest';
import {compressResume,declaredPixels,imagePdf,looksLike,PDF_KEEP_BELOW,readZip,writeZip} from '../lib/resumes/compress';
import {readDocumentText} from '../lib/live/documentText';

/** A photo-like picture that does not shrink to nothing: soft colour with fine grain (fixed, repeatable noise). */
function photo(width:number,height:number){
 const canvas=createCanvas(width,height),context=canvas.getContext('2d'),image=context.createImageData(width,height);
 let seed=7;
 for(let i=0;i<image.data.length;i+=4){seed=(seed*1103515245+12345)>>>0;const grain=seed%38;const x=(i/4)%width,y=Math.floor(i/4/width);
  image.data[i]=Math.min(255,120+Math.floor(x/width*90)+grain);image.data[i+1]=Math.min(255,100+Math.floor(y/height*100)+grain);image.data[i+2]=150+grain;image.data[i+3]=255;}
 context.putImageData(image,0,0);return canvas;
}
/** A one-page résumé PDF with real text in a standard (not embedded) font beside a heavy picture. */
async function heavyPdf(){
 const jpeg=Buffer.from(await photo(1600,2000).encode('jpeg',95));
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /XObject << /I 6 0 R >> >> /Contents 4 0 R >>',
  null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',null];
 const content=Buffer.from('q 200 0 0 250 360 560 cm /I Do Q BT /F1 22 Tf 40 780 Td (Ananya Sharma - Java Developer) Tj 0 -30 Td /F1 12 Tf (Spring Boot, Kafka, PostgreSQL and five years of building payment services.) Tj 0 -18 Td (Led a team of four and cut checkout errors by half.) Tj 0 -18 Td (B.Tech in Computer Science.) Tj 0 -18 Td (Hyderabad, India.) Tj 0 -18 Td (Open to hybrid work.) Tj ET');
 const parts:Buffer[]=[Buffer.from('%PDF-1.4\n')],offsets:number[]=[];let length=parts[0].length;
 const push=(b:Buffer)=>{parts.push(b);length+=b.length;};
 objects.forEach((body,index)=>{const id=index+1;offsets[id]=length;
  if(id===4)push(Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`),content,Buffer.from('\nendstream\nendobj\n')]));
  else if(id===6)push(Buffer.concat([Buffer.from(`6 0 obj\n<< /Type /XObject /Subtype /Image /Width 1600 /Height 2000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream\nendobj\n')]));
  else push(Buffer.from(`${id} 0 obj\n${body}\nendobj\n`));});
 const xref=length;push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
 return Buffer.concat(parts);
}
async function renderPage(bytes:Buffer){
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0});const doc=await task.promise;const page=await doc.getPage(1);
 const viewport=page.getViewport({scale:1});const canvas=createCanvas(Math.round(viewport.width),Math.round(viewport.height)),context=canvas.getContext('2d');
 context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);await page.render({canvas:canvas as unknown as HTMLCanvasElement,viewport}).promise;
 const result={pages:doc.numPages,width:viewport.width,height:viewport.height,pixels:context.getImageData(0,0,canvas.width,canvas.height).data,canvas};await task.destroy();return result;
}
/** Dark pixels inside a box: where the text is. */
const ink=(pixels:Uint8ClampedArray,width:number,x:number,y:number,w:number,h:number)=>{let n=0;for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){const i=(row*width+col)*4;if(pixels[i]<120&&pixels[i+1]<120&&pixels[i+2]<120)n++;}return n;};

it('shrinks a picture-heavy PDF to a fraction while keeping every page, its size and its text readable',async()=>{
 const original=await heavyPdf();expect(original.length).toBeGreaterThan(PDF_KEEP_BELOW);
 const result=await compressResume(original,'PDF');
 expect(result.compression).toBe('pdf-pages');expect(result.bytes.length).toBeLessThan(original.length*0.4);
 const drawn=await renderPage(result.bytes);
 expect([drawn.pages,Math.round(drawn.width),Math.round(drawn.height)]).toEqual([1,595,842]);
 // The heading line (standard Helvetica) was drawn, not lost.
 expect(ink(drawn.pixels,595,40,42,320,24)).toBeGreaterThan(200);
 expect(looksLike(result.bytes,'PDF')).toBe(true);
},60_000);
it('keeps a small PDF as it is, and keeps the original when a file cannot be read',async()=>{
 const small=imagePdf([{jpeg:Buffer.from(await photo(60,80).encode('jpeg',60)),widthPoints:595,heightPoints:842,width:60,height:80}]);
 expect(await compressResume(small,'PDF')).toEqual({bytes:small,compression:'original'});
 const broken=Buffer.concat([Buffer.from('%PDF-1.4 broken'),Buffer.alloc(PDF_KEEP_BELOW+10,1)]);
 expect((await compressResume(broken,'PDF')).compression).toBe('original');
 expect((await compressResume(Buffer.from('not a zip at all'),'DOCX')).compression).toBe('original');
},60_000);
it('repacks a Word résumé with a large photo without changing its words',async()=>{
 const text='<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Ananya Sharma, Java Developer</w:t></w:r></w:p><w:p><w:r><w:t>Spring Boot and Kafka.</w:t></w:r></w:p></w:body></w:document>';
 const picture=Buffer.from(await photo(2400,2400).encode('png'));
 const rels='<Relationships><Relationship Id="rId1" Target="media/image1.png"/><Relationship Id="rId2" Target="media/image10.png"/></Relationships>';
 const docx=writeZip([{name:'[Content_Types].xml',data:Buffer.from('<Types><Default Extension="png" ContentType="image/png"/></Types>')},{name:'word/document.xml',data:Buffer.from(text)},
  {name:'word/_rels/document.xml.rels',data:Buffer.from(rels)},{name:'word/media/image1.png',data:picture},{name:'word/media/image10.png',data:Buffer.from('tiny-logo')}]);
 expect(looksLike(docx,'DOCX')).toBe(true);
 const result=await compressResume(docx,'DOCX');
 expect(result.compression).toBe('docx-repacked');expect(result.bytes.length).toBeLessThan(docx.length*0.5);
 const entries=readZip(result.bytes);
 expect(entries.map(e=>e.name)).toEqual(['[Content_Types].xml','word/document.xml','word/_rels/document.xml.rels','word/media/image1.jpg','word/media/image10.png']);
 expect(entries[1].data.toString()).toBe(text);
 // The photo became a JPEG and the document still points to it; the small logo is untouched.
 expect(entries[2].data.toString()).toBe(rels.replace('media/image1.png','media/image1.jpg'));
 expect(entries[0].data.toString()).toContain('<Default Extension="jpg" ContentType="image/jpeg"/>');
 expect(entries[3].data.subarray(0,3)).toEqual(Buffer.from([255,216,255]));expect(entries[4].data.toString()).toBe('tiny-logo');
 const words=await readDocumentText(new File([new Uint8Array(result.bytes)],'cv.docx'));
 expect(words.text).toContain('Ananya Sharma, Java Developer');expect(words.text).toContain('Spring Boot and Kafka.');
},60_000);
it('reads picture sizes from their headers, so a tiny file cannot claim an enormous picture',async()=>{
 const jpeg=Buffer.from(await photo(321,123).encode('jpeg',80)),png=Buffer.from(await photo(45,67).encode('png'));
 expect([declaredPixels(jpeg,'jpeg'),declaredPixels(png,'png'),declaredPixels(Buffer.from('x'),'jpeg')]).toEqual([321*123,45*67,null]);
 const bomb=Buffer.from(png);bomb.writeUInt32BE(100_000,16);bomb.writeUInt32BE(100_000,20);
 const padded=Buffer.concat([bomb,Buffer.alloc(80*1024)]);
 const docx=writeZip([{name:'[Content_Types].xml',data:Buffer.from('<Types></Types>')},{name:'word/document.xml',data:Buffer.from('<w:t>x</w:t>')},{name:'word/media/image1.png',data:padded}]);
 const result=await compressResume(docx,'DOCX');
 expect(readZip(result.bytes).find(e=>e.name==='word/media/image1.png')!.data.equals(padded)).toBe(true);
},60_000);
it('recognises a file that is not what it claims to be',()=>{
 expect(looksLike(Buffer.from('MZ not a pdf'),'PDF')).toBe(false);
 expect(looksLike(writeZip([{name:'evil.exe',data:Buffer.from('x')}]),'DOCX')).toBe(false);
 expect(()=>readZip(Buffer.from('PK'))).toThrow();
});
