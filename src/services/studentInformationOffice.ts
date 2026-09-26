import { spawn } from "node:child_process";
import { privateNativeProcessing } from "./privateNativeProcessing.js";
import { informationError } from "./studentInformationValidation.js";

export type InformationSection = {
  label: string;
  text: string;
  hidden: boolean;
  warnings: string[];
  rows: number;
  columns: number;
  sheet: string | null;
  units: number;
};
export type OfficeResult = {
  sections: InformationSection[];
  warnings: string[];
};
// The child receives only a bounded buffer and a media type. No credentials,
// filesystem input paths, network clients, or document-controlled commands.
const OFFICE_CHILD = String.raw`
const fs=require('node:fs'),yauzl=require('yauzl');
let input=[];let size=0;process.stdin.on('data',c=>{size+=c.length;if(size>15*1024*1024)process.exit(2);input.push(c)});
const fail=()=>{process.stdout.write(JSON.stringify({error:'INVALID_OFFICE'}));process.exitCode=2};
async function zip(bytes) {
  return new Promise((resolve,reject) => {
    yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true},(error,archive) => {
      if(error || !archive) return reject(Error());
      let count=0, declared=0, expanded=0;
      const names=new Set(), warnings=[];
      const rejectArchive=() => { archive.close(); reject(Error()); };
      archive.on('error',rejectArchive);
      archive.on('entry',entry => {
        if(++count>1000 || entry.generalPurposeBitFlag&1 || entry.uncompressedSize>10*1024*1024 || (declared+=entry.uncompressedSize)>32*1024*1024 || names.has(entry.fileName) || entry.fileName.includes('..') || entry.fileName.startsWith('/') || /vbaProject|\.bin$|embeddings\//i.test(entry.fileName)) return rejectArchive();
        names.add(entry.fileName);
        if(/media\//.test(entry.fileName)) warnings.push('embedded_images_unsupported');
        const inspect=/\.rels$|^word\/document\.xml$/.test(entry.fileName);
        // Drain every entry through the size-validating reader before either
        // Office library sees it, including entries whose labels are ignored.
        archive.openReadStream(entry,(streamError,stream) => {
          if(streamError || !stream) return rejectArchive();
          let actual=0; const chunks=[];
          stream.on('data',chunk => {
            actual+=chunk.length; expanded+=chunk.length;
            if(actual>10*1024*1024 || expanded>32*1024*1024 || (inspect && actual>1024*1024)) { stream.destroy(); rejectArchive(); }
            else if(inspect) chunks.push(chunk);
          });
          stream.on('error',rejectArchive);
          stream.on('end',() => {
            if(inspect) {
              const xml=Buffer.concat(chunks).toString();
              if(/TargetMode\s*=\s*["']External/i.test(xml)) warnings.push('external_links_excluded');
              if(/<(?:w:)?(?:vanish|webHidden)(?:\s|\/|>)/.test(xml)) warnings.push('hidden_document_content');
            }
            archive.readEntry();
          });
        });
      });
      archive.on('end',() => resolve({names,warnings:[...new Set(warnings)]}));
      archive.readEntry();
    });
  });
}
process.stdin.on('end',async()=>{try{const i=JSON.parse(Buffer.concat(input).toString());const bytes=Buffer.from(i.data,'base64');if(!bytes.length||bytes.length>10485760)throw Error();let sections=[],warnings=[];
const add=(s)=>{if(Buffer.byteLength(s.text)>1048576||sections.length>=100)throw Error();sections.push(s)};
if(i.type==='text/csv'){const {parse}=require('csv-parse/sync');const rows=parse(bytes,{bom:true,relax_column_count:false,max_record_size:200000,skip_empty_lines:true});if(rows.length>500||rows.some(r=>r.length>50))throw Error();for(let j=0;j<rows.length;j+=25){const part=rows.slice(j,j+25);const formula=part.some(r=>r.some(c=>/^[=+@-]/.test(c)));add({label:'CSV rows '+(j+1)+'–'+(j+part.length),text:JSON.stringify(part),hidden:false,warnings:formula?['formula_manual_resolution']:[],rows:part.length,columns:Math.max(0,...part.map(r=>r.length)),sheet:'CSV',units:1})}}
else{const archive=await zip(bytes);warnings=archive.warnings;
if(i.type.includes('wordprocessingml')){if(!archive.names.has('word/document.xml'))throw Error();const mammoth=require('mammoth');const result=await mammoth.convertToHtml({buffer:bytes},{externalFileAccess:false,includeEmbeddedStyleMap:false,convertImage:mammoth.images.imgElement(async()=>({src:''}))});if(result.messages.length)warnings.push('unsupported_document_content');
// HTML is never returned or rendered. Preserve table cells/headings as plain
// escaped text; explicit selection happens before any provider transmission.
let plain=result.value.replace(/<\/(?:h[1-6]|p|tr)>/gi,'\n').replace(/<\/(?:td|th)>/gi,'\t').replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
if(Buffer.byteLength(plain)>1048576)throw Error();for(let j=0;j<plain.length;j+=4000)add({label:'Document section '+(1+j/4000),text:plain.slice(j,j+4000),hidden:warnings.includes('hidden_document_content'),warnings:[...warnings],rows:0,columns:0,sheet:null,units:1});}
else if(i.type.includes('spreadsheetml')){if(!archive.names.has('xl/workbook.xml'))throw Error();const ExcelJS=require('exceljs'),w=new ExcelJS.Workbook();await w.xlsx.load(bytes,{ignoreNodes:['drawing','picture','extLst']});if(w.worksheets.length>50)throw Error();let totalRows=0;for(const sheet of w.worksheets){if(sheet.rowCount>2000||sheet.columnCount>50||(totalRows+=sheet.rowCount)>2000)throw Error();let batch=[];const flush=()=>{if(!batch.length)return;const hidden=batch.some(r=>r.hidden)||sheet.state!=='visible';const issues=[...new Set(batch.flatMap(r=>r.warnings))];add({label:sheet.name.slice(0,100)+' rows '+batch[0].n+'–'+batch[batch.length-1].n,text:JSON.stringify(batch.map(r=>r.values)),hidden,warnings:issues,rows:batch.length,columns:sheet.columnCount,sheet:sheet.id.toString(),units:1});batch=[]};sheet.eachRow({includeEmpty:true},(row,n)=>{let issues=[],hidden=row.hidden===true,values=[];for(let c=1;c<=sheet.columnCount;c++){const cell=row.getCell(c);hidden ||= sheet.getColumn(c).hidden===true;let value=cell.value;if(value&&typeof value==='object'&&('formula'in value||'sharedFormula'in value)){issues.push('formula_manual_resolution');value='[Formula: manual value required]'}else if(value&&typeof value==='object'&&'richText'in value)value=value.richText.map(t=>t.text).join('');else if(value&&typeof value==='object'&&'hyperlink'in value){issues.push('external_links_excluded');value=value.text||''}else if(value instanceof Date){issues.push('date_value_requires_review');value=value.toISOString()}else if(typeof value==='number'){issues.push('numeric_identifier_requires_review');value=/^0+$/.test(cell.numFmt||'')&&Number.isSafeInteger(value)&&value>=0?String(value).padStart(cell.numFmt.length,'0'):cell.text}values.push(value===null?'':String(value));}if(batch.length&&(batch[0].hidden!==hidden))flush();batch.push({n,values,hidden,warnings:issues});if(batch.length===25)flush()});flush()}}
else throw Error();}
const result={sections,warnings:[...new Set(warnings)]};if(!sections.length||Buffer.byteLength(JSON.stringify(result))>1048576)throw Error();process.stdout.write(JSON.stringify(result));}catch{fail()}});
`;

/** A killed child cannot retain a permit; all parsing finishes before release. */
export async function parseInformationOffice(
  bytes: Buffer,
  contentType: string,
): Promise<OfficeResult> {
  if (bytes.length > 10 * 1024 * 1024 || !bytes.length)
    throw informationError(
      422,
      "SOURCE_LIMIT",
      "Choose a nonempty file no larger than 10 MiB",
    );
  return privateNativeProcessing.run(
    () =>
      new Promise<OfficeResult>((resolve, reject) => {
        const nodeArgs = [
          "--jitless",
          "--no-expose-wasm",
          "--max-old-space-size=96",
          "--max-semi-space-size=4",
          "-e",
          OFFICE_CHILD,
        ];
        const command =
          process.platform === "linux" ? "/usr/bin/prlimit" : process.execPath;
        const args =
          process.platform === "linux"
            ? [
                "--as=536870912",
                "--cpu=20",
                "--nofile=64",
                "--fsize=2097152",
                "--",
                process.execPath,
                ...nodeArgs,
              ]
            : nodeArgs;
        const child = spawn(command, args, {
          windowsHide: true,
          shell: false,
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            LANG: "C",
            NODE_ENV: "production",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = Buffer.alloc(0),
          failed = false;
        const stop = () => {
          failed = true;
          child.kill("SIGKILL");
        };
        const timer = setTimeout(stop, 20_000);
        child.stdout.on("data", (chunk: Buffer) => {
          if (output.length + chunk.length > 1024 * 1024) stop();
          else output = Buffer.concat([output, chunk]);
        });
        child.stderr.on("data", () => {
          /* Never retain parser diagnostics or excerpts. */
        });
        child.on("error", () => {
          failed = true;
        });
        child.stdin.on("error", () => {
          failed = true;
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (failed || code !== 0) {
            reject(
              informationError(
                422,
                "UNSUPPORTED_SOURCE",
                "This file is unreadable, unsupported, encrypted, macro-enabled, or exceeds import limits",
              ),
            );
            return;
          }
          try {
            const value = JSON.parse(output.toString()) as OfficeResult;
            if (!Array.isArray(value.sections)) throw Error();
            resolve(value);
          } catch {
            reject(
              informationError(
                422,
                "UNSUPPORTED_SOURCE",
                "This file could not be safely read",
              ),
            );
          }
        });
        child.stdin.end(
          JSON.stringify({ type: contentType, data: bytes.toString("base64") }),
        );
      }),
  );
}
