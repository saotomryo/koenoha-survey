export async function extractContextFile(file) {
  if (!/\.(txt|md|pdf)$/i.test(file.name)) throw new Error('TXT・Markdown・PDFのみ利用できます。');
  if (file.name.length > 200 || file.size > 2 * 1024 * 1024) throw new Error('ファイル名は200文字、ファイルサイズは2MBまでです。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text;
  if (/\.pdf$/i.test(file.name)) {
    const pdfjs = await import('/vendor/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, useWasm: false, cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/' });
    let timer;
    try {
      text = await Promise.race([
        (async () => {
          const pdf = await task.promise;
          if (pdf.numPages > 50) throw new Error('PDFは50ページまでです。');
          let result = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            result += content.items.map(item => item.str ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
            if (result.length > 12000) throw new Error('抽出テキストは12000文字までです。資料を短くして再度取り込んでください。');
            page.cleanup();
          }
          return result;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDFの読み取りが時間切れになりました。')), 20000); })
      ]);
    } catch (error) {
      if (error.name === 'PasswordException') throw new Error('パスワード付きPDFは読み取れません。');
      if (error.name === 'InvalidPDFException') throw new Error('PDFを読み取れません。別のファイルを指定してください。');
      throw error;
    } finally { clearTimeout(timer); await task.destroy(); }
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('テキストファイルはUTF-8形式で指定してください。'); }
  }
  text = text.trim();
  if (!text) throw new Error('テキストを抽出できませんでした。画像・スキャンPDFは未対応です。');
  if (text.includes('\u0000')) throw new Error('テキストとして読み取れないファイルです。');
  if (text.length > 12000) throw new Error('参考ファイルは12000文字までです。資料を短くして再度取り込んでください。');
  return { name: file.name, text };
}
