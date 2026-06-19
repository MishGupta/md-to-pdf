import * as vscode from 'vscode';
import * as fs from 'fs';
import MarkdownIt from 'markdown-it';
const puppeteer = require('puppeteer');
const browsers = require('@puppeteer/browsers');

// The Chromium build that this puppeteer version expects. Read from
// puppeteer-core when available so it stays in sync across upgrades;
// fall back to the build pinned at the time of writing.
function pinnedChromeBuild(): string {
    try {
        return require('puppeteer-core/internal/revisions.js').PUPPETEER_REVISIONS.chrome;
    } catch {
        return '149.0.7827.22';
    }
}

// Chromium is downloaded into the extension's own global storage on first
// use (instead of shipping a ~150 MB binary inside the .vsix) and reused
// afterwards. Returns the path to the browser executable.
async function ensureBrowser(context: vscode.ExtensionContext): Promise<string> {
    const cacheDir = context.globalStorageUri.fsPath;
    const platform = browsers.detectBrowserPlatform();
    const buildId = pinnedChromeBuild();
    const executablePath = browsers.computeExecutablePath({
        browser: browsers.Browser.CHROME,
        platform,
        buildId,
        cacheDir,
    });

    if (fs.existsSync(executablePath)) {
        return executablePath;
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading Chromium (first run only)…',
            cancellable: false,
        },
        async (progress) => {
            let lastPct = 0;
            await browsers.install({
                browser: browsers.Browser.CHROME,
                platform,
                buildId,
                cacheDir,
                downloadProgressCallback: (downloaded: number, total: number) => {
                    const pct = Math.round((downloaded / total) * 100);
                    if (pct > lastPct) {
                        progress.report({ increment: pct - lastPct, message: `${pct}%` });
                        lastPct = pct;
                    }
                },
            });
        },
    );

    return executablePath;
}

export function activate(context: vscode.ExtensionContext) {

    const disposable = vscode.commands.registerCommand(
        'mishka.md-to-pdf.convert',
        // When invoked from the explorer context menu, VSCode passes the
        // clicked file's Uri. When invoked from the command palette, it's
        // undefined and we fall back to the active editor.
        async (uri?: vscode.Uri) => {

            let mdContent: string;
            let sourcePath: string;

            if (uri) {
                const doc = await vscode.workspace.openTextDocument(uri);
                mdContent = doc.getText();
                sourcePath = doc.fileName;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No Markdown file open');
                    return;
                }
                if (editor.document.languageId !== 'markdown') {
                    vscode.window.showErrorMessage('The active file is not Markdown');
                    return;
                }
                // Persist unsaved edits so the PDF matches what's on screen.
                await editor.document.save();
                mdContent = editor.document.getText();
                sourcePath = editor.document.fileName;
            }

            const pdfPath = sourcePath.replace(/\.md$/i, '.pdf');

            const md = new MarkdownIt();
            const body = md.render(mdContent);
            const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif;
         line-height: 1.6; color: #24292e; }
  pre, code { font-family: SFMono-Regular, Consolas, monospace; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto; }
  code { background: #f6f8fa; padding: 2px 4px; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #dfe2e5; padding: 6px 12px; }
  blockquote { color: #6a737d; border-left: 4px solid #dfe2e5;
               margin: 0; padding: 0 16px; }
  img { max-width: 100%; }
</style>
</head>
<body>${body}</body>
</html>`;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Converting Markdown to PDF…',
                    cancellable: false,
                },
                async () => {
                    let browser;
                    try {
                        const executablePath = await ensureBrowser(context);
                        browser = await puppeteer.launch({ headless: true, executablePath });
                        const page = await browser.newPage();
                        // 'domcontentloaded' returns as soon as the HTML is
                        // parsed and never waits on network resources, so a
                        // slow/broken image can't cause a navigation timeout.
                        await page.setContent(html, { waitUntil: 'domcontentloaded' });
                        await page.pdf({
                            path: pdfPath,
                            format: 'A4',
                            printBackground: true,
                            margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' },
                        });
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`PDF conversion failed: ${message}`);
                        return;
                    } finally {
                        await browser?.close();
                    }

                    const choice = await vscode.window.showInformationMessage(
                        `PDF saved: ${pdfPath}`,
                        'Open',
                    );
                    if (choice === 'Open') {
                        await vscode.env.openExternal(vscode.Uri.file(pdfPath));
                    }
                },
            );
        },
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {}
