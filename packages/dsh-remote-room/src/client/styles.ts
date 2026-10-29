/** Scoped share-flow styles. Every color derives from live Harness theme aliases. */
export const styles = `
.rr{
  --rr-accent:color-mix(in oklab,var(--dsw-alias-brand-primary,#4d6bfe) 72%,#2f7d6d);
  --rr-accent-soft:color-mix(in oklab,var(--rr-accent) 12%,transparent);
  --rr-line:var(--dsw-alias-border-l1);
  --rr-line-strong:var(--dsw-alias-border-l2);
  --rr-layer:var(--dsw-alias-bg-layer-1);
  --rr-layer-2:var(--dsw-alias-bg-layer-2);
  --rr-ink:var(--dsw-alias-label-primary);
  --rr-ink-soft:var(--dsw-alias-label-secondary);
  --rr-serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif;
  --rr-mono:"Cascadia Code",ui-monospace,SFMono-Regular,Menlo,monospace;
  box-sizing:border-box;height:100%;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--rr-ink);font:inherit;font-size:13px;container-type:inline-size
}
.rr *{box-sizing:border-box}
/* Zero-specificity reset: component rules below must be able to set background and border. */
.rr :where(button){font:inherit;color:inherit;cursor:pointer;background:none;border:0}
.rr :where(button):disabled{cursor:not-allowed;opacity:.42}
.rr :focus-visible{outline:2px solid var(--rr-accent);outline-offset:2px;border-radius:6px}
.rr-stage{display:flex;flex-direction:column;gap:14px;max-width:720px;margin:0 auto;padding:28px 24px 56px}
.rr-hero{display:flex;flex-direction:column;gap:6px;margin-bottom:4px}
.rr-hero h1{font-family:var(--rr-serif);font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1.25;margin:0}
.rr-hero p{margin:0;color:var(--rr-ink-soft);line-height:1.65}
.rr-hero-room{flex-direction:row;align-items:flex-start;justify-content:space-between;gap:16px}
.rr-herotext{display:flex;flex-direction:column;gap:5px;min-width:0}
.rr-herotext h1{font-size:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-herotext p{font-family:var(--rr-mono);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-statusrow{display:flex;align-items:center;gap:8px;flex:none}
.rr-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none}
.rr-dot[data-live=true]{background:var(--dsw-alias-state-success-primary)}
.rr-card{border:1px solid var(--rr-line);border-radius:14px;background:var(--rr-layer);padding:18px;display:flex;flex-direction:column;gap:12px;transition:border-color .16s ease}
.rr-card:focus-within{border-color:color-mix(in oklab,var(--rr-accent) 45%,var(--rr-line))}
.rr-cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.rr-cardhead h2{margin:0;font-size:13px;font-weight:600;letter-spacing:.01em}
.rr-field{display:flex;flex-direction:column;gap:7px}
.rr-fieldlabel{font-size:11px;font-weight:600;color:var(--rr-ink-soft);letter-spacing:.04em}
.rr-fieldhint{font-size:11px;color:var(--rr-ink-soft);line-height:1.6}
.rr-hint{margin:0;font-size:11.5px;line-height:1.65;color:var(--rr-ink-soft)}
.rr-center{text-align:center}
.rr-body{margin:0;line-height:1.7}
.rr-path{margin:0;font-family:var(--rr-mono);font-size:12px;line-height:1.6;overflow-wrap:anywhere;color:var(--rr-ink)}
.rr-path[data-empty=true]{color:var(--rr-ink-soft);font-style:italic}
.rr-input{width:100%;border:1px solid var(--rr-line-strong);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--rr-ink);padding:9px 11px;font-size:12.5px;line-height:1.5;transition:border-color .16s ease}
.rr-input:focus{outline:none;border-color:var(--rr-accent)}
.rr-mono{font-family:var(--rr-mono)}
.rr-invite{resize:vertical;min-height:64px}
.rr-inline{display:flex;gap:8px;align-items:center}
.rr-inline .rr-input{flex:1;min-width:0}
.rr-end{align-self:flex-start}
.rr-link{align-self:flex-start;font-size:11.5px;color:var(--rr-ink-soft);text-decoration:underline;text-underline-offset:3px;padding:2px 0}
.rr-link:hover{color:var(--rr-accent)}
.rr-btn{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:5px 10px;border:1px solid var(--rr-line-strong);border-radius:9px;background:var(--dsw-alias-bg-base);font-size:12px;font-weight:500;line-height:1.4;transition:background .14s ease,border-color .14s ease,transform .14s ease}
.rr-btn:hover:not(:disabled){background:var(--rr-layer-2);border-color:var(--rr-accent)}
.rr-btn[data-variant=primary]{background:var(--rr-accent);border-color:var(--rr-accent);color:#fff}
.rr-btn[data-variant=primary]:hover:not(:disabled){filter:brightness(1.06);background:var(--rr-accent)}
.rr-btn[data-variant=ghost]{background:transparent}
.rr-primary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;border-radius:12px;background:var(--rr-accent);color:#fff;font-size:14px;font-weight:600;letter-spacing:.01em;box-shadow:0 1px 2px color-mix(in oklab,var(--rr-accent) 30%,transparent);transition:filter .16s ease,transform .16s ease}
.rr-primary:hover:not(:disabled){filter:brightness(1.06)}
.rr-primary:active:not(:disabled){transform:translateY(1px)}
.rr-choice{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.rr-option{display:flex;align-items:center;justify-content:center;min-height:34px;padding:6px 8px;border:1px solid var(--rr-line-strong);border-radius:10px;font-size:12px;font-weight:500;color:var(--rr-ink-soft);transition:border-color .14s ease,color .14s ease,background .14s ease}
.rr-option:hover{border-color:var(--rr-accent);color:var(--rr-ink)}
.rr-option[data-active=true]{border-color:var(--rr-accent);background:var(--rr-accent-soft);color:var(--rr-accent);font-weight:600}
.rr-option[data-danger=true][data-active=true]{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.rr-callout{margin:0;padding:9px 11px;border-radius:10px;background:var(--rr-layer-2);color:var(--rr-ink-soft);font-size:11.5px;line-height:1.65;display:flex;align-items:center;gap:7px}
.rr-callout[data-tone=danger]{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}
.rr-callout[data-tone=warning]{background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-primary)}
.rr-pill{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.02em;white-space:nowrap;flex:none;background:var(--rr-layer-2);color:var(--rr-ink-soft);border:1px solid var(--rr-line)}
.rr-summary{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--rr-line);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--rr-ink-soft);font-size:11.5px}
.rr-summary-label{white-space:nowrap}
.rr-summary-value{flex:1;min-width:0;font-family:var(--rr-mono);font-size:11.5px;color:var(--rr-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.rr-pill[data-tone=success]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in oklab,var(--dsw-alias-state-success-primary) 35%,var(--rr-line))}
.rr-pill[data-tone=warning]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 35%,var(--rr-line))}
.rr-pill[data-tone=danger]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 35%,var(--rr-line))}
.rr-invitebox{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px dashed var(--rr-line-strong);border-radius:10px;background:var(--dsw-alias-bg-base)}
.rr-invitecode{flex:1;min-width:0;font-family:var(--rr-mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rr-ink-soft)}
.rr-actions{display:flex;gap:8px;flex-wrap:wrap}
.rr-request{border-color:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 30%,var(--rr-line))}
.rr-tree{display:flex;flex-direction:column;gap:8px;border:1px solid var(--rr-line);border-radius:14px;background:var(--rr-layer);padding:12px}
.rr-treebar{display:flex;align-items:center;gap:8px}
.rr-crumb{font-size:11.5px;color:var(--rr-ink-soft);padding:4px 6px;border-radius:7px}
.rr-crumb:hover:not(:disabled){background:var(--rr-layer-2);color:var(--rr-ink)}
.rr-treebar-path{flex:1;min-width:0;font-family:var(--rr-mono);font-size:11px;color:var(--rr-ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.rr-row{display:flex;align-items:center;gap:9px;width:100%;padding:7px 8px;border-radius:8px;text-align:left;color:var(--rr-ink);transition:background .12s ease}
.rr-row:hover:not(:disabled){background:var(--rr-layer-2)}
.rr-rowname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.rr-rowsize{font-family:var(--rr-mono);font-size:10.5px;color:var(--rr-ink-soft)}
.rr-empty{display:flex;flex-direction:column;gap:4px;align-items:center;padding:22px 12px;border:1px dashed var(--rr-line-strong);border-radius:12px;color:var(--rr-ink-soft);font-size:12px;text-align:center}
.rr-empty strong{font-weight:500;color:var(--rr-ink)}
.rr-audit{border-top:1px solid var(--rr-line);padding-top:10px}
.rr-audit summary{cursor:pointer;font-size:11.5px;color:var(--rr-ink-soft);padding:4px 0}
.rr-audit summary:hover{color:var(--rr-ink)}
.rr-audit ul{list-style:none;margin:8px 0 0;padding:0;max-height:220px;overflow:auto;font-family:var(--rr-mono);font-size:10.5px;line-height:1.8;color:var(--rr-ink-soft)}
.rr-audit time{margin-right:10px;opacity:.7}
.rr-bannerline{padding:7px 16px;background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:11.5px;text-align:center}
.rr-errorline{display:flex;align-items:center;gap:9px;margin:10px 16px;padding:9px 11px;border-radius:10px;background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11.5px}
.rr-errorline span{flex:1;min-width:0;overflow-wrap:anywhere}
.rr-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--rr-line-strong);border-top-color:var(--rr-accent);animation:rr-spin .8s linear infinite}
.rr-foot{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--rr-ink-soft);padding-top:2px}
.rr-end{margin-top:2px}
.rr-hidden-copy{display:none}
@keyframes rr-spin{to{transform:rotate(360deg)}}
@keyframes rr-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.rr-stage>*{animation:rr-rise .22s ease both}
.rr-stage>*:nth-child(2){animation-delay:.03s}
.rr-stage>*:nth-child(3){animation-delay:.06s}
.rr-stage>*:nth-child(4){animation-delay:.09s}
.rr-stage>*:nth-child(5){animation-delay:.12s}
.rr-preview{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}
.rr-previewbody{flex:1;min-height:0;overflow:auto;padding:0}
.rr-previewbody[data-rr-renderer=markdown]{padding:20px 24px 56px}
.rr-previewbody[data-image=true]{padding:18px;background:var(--rr-layer-2)}
.rr-document{max-width:var(--dsw-document-measure,860px)}
.rr-image{display:block;max-width:100%;height:auto;margin:auto;border-radius:4px}
.rr-skeleton{display:flex;flex-direction:column;gap:10px;padding:20px 24px}
.rr-skeleton span{height:12px;border-radius:6px;background:var(--rr-layer-2);animation:rr-pulse 1.2s ease-in-out infinite}
.rr-skeleton span:nth-child(2){width:82%}
.rr-skeleton span:nth-child(3){width:64%}
.rr-skeleton span:nth-child(4){width:74%}
@keyframes rr-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.rr-stalechip{position:absolute;top:8px;inset-inline-end:12px;z-index:2;margin:0;padding:3px 9px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:10.5px;line-height:1.5}
.rr-emptyhint{margin:0;padding:24px;color:var(--rr-ink-soft);font-size:12px}
.rr-bannerwrap{padding:8px 12px}
@container(max-width:520px){.rr-stage{padding:20px 14px 44px}.rr-choice{grid-template-columns:1fr}.rr-hero-room{flex-direction:column}.rr-hero h1{font-size:22px}}
@media(prefers-reduced-motion:reduce){.rr *,.rr-stage>*{animation:none!important;transition:none!important}}
`
