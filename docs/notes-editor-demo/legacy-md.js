// 从 tidywork-plugin/lib/client.js 原样抽出的自研渲染器，仅用于对照（不要改业务代码）
const MD_CSS = [
			".tw-md{font-size:14px;line-height:1.78;color:var(--dsw-alias-label-primary,#1f2329);word-break:break-word;overflow-wrap:anywhere}",
			".tw-md h1,.tw-md h2,.tw-md h3,.tw-md h4,.tw-md h5,.tw-md h6{margin:20px 0 10px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary,#1f2329)}",
			".tw-md h1{font-size:24px}.tw-md h2{font-size:20px}.tw-md h3{font-size:17px}.tw-md h4,.tw-md h5,.tw-md h6{font-size:15px}",
			".tw-md p{margin:10px 0}",
			".tw-md a{color:var(--tw-accent,#3370ff);text-decoration:none}.tw-md a:hover{text-decoration:underline}",
			".tw-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 7%,transparent);padding:2px 5px;border-radius:4px}",
			".tw-md pre{position:relative;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 6%,transparent);border:1px solid var(--dsw-alias-border-l1,#f0f0f0);border-radius:8px;padding:12px 14px;margin:12px 0;overflow:auto}",
			".tw-md pre code{background:none;padding:0;font-size:12.5px;line-height:1.6;white-space:pre}",
			".tw-md .tw-copy{position:absolute;top:8px;right:8px;font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#646a73);cursor:pointer;opacity:0;transition:opacity .15s;font-family:inherit}",
			".tw-md pre:hover .tw-copy{opacity:1}",
			".tw-md table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}",
			".tw-md th,.tw-md td{border:1px solid var(--dsw-alias-border-l2,#e5e6eb);padding:6px 10px;text-align:left;vertical-align:top}",
			".tw-md th{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 6%,transparent);font-weight:600}",
			".tw-md blockquote{margin:12px 0;padding:2px 0 2px 12px;border-left:3px solid var(--dsw-alias-border-l2,#e5e6eb);color:var(--dsw-alias-label-secondary,#646a73)}",
			".tw-md ul,.tw-md ol{margin:8px 0;padding-left:22px}",
			".tw-md li{margin:3px 0}",
			".tw-md li.tw-task{list-style:none;margin-left:-22px;display:flex;gap:8px;align-items:flex-start}",
			".tw-md .tw-check{width:15px;height:15px;flex:0 0 auto;margin-top:4px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;color:transparent;cursor:pointer;background:transparent}",
			'.tw-md .tw-check[data-check="1"]{background:var(--tw-accent,#3370ff);border-color:var(--tw-accent,#3370ff);color:#fff}',
			".tw-md img{max-width:100%;border-radius:8px;margin:10px 0;display:block}",
			".tw-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,#f0f0f0);margin:18px 0}",
			".tw-plain{white-space:pre-wrap;font-size:14px;line-height:1.78;word-break:break-word}",
			".tw-tool{display:inline-flex;align-items:center;padding:4px 9px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#646a73);font-size:12.5px;cursor:pointer;font-family:inherit;line-height:1.5}",
			".tw-tool:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 6%,transparent);color:var(--dsw-alias-label-primary,#1f2329)}",
			".tw-live-b{cursor:text;border-radius:6px}",
			".tw-live-b:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 4%,transparent)}",
			".tw-live-empty{color:var(--dsw-alias-label-tertiary,#8f959e);font-size:13px;padding:20px 0;cursor:text}",
			".tw-live .tw-live-ta::placeholder{color:var(--dsw-alias-label-tertiary,#8f959e)}",
			".tw-live .tw-live-ta{font-size:14px}"
		].join("");

		
function mdEscape(s) {
			return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
		}

		/** 链接白名单：内链 todo:/meeting:、站内相对路径、http(s)、mailto；其余（javascript/data 等）不渲染。 */
		function mdUrl(u) {
			const s = String(u || "").trim();
			if (!s) return "";
			if (/^(todo|meeting):/i.test(s)) return s;
			if (s.startsWith("/")) return s;
			if (/^(https?:|mailto:)/i.test(s)) return s;
			return "";
		}

		function mdImgUrl(u) {
			const s = String(u || "").trim();
			if (s.startsWith("/") && !s.startsWith("//")) return location.origin + s;
			if (/^https?:/i.test(s)) return s;
			return "";
		}

		/** 行内语法：代码 > 图片 > 链接 > 强调。代码先占位，避免后续替换破坏已生成的标签。 */
		function mdInline(raw) {
			const slots = [];
			let s = String(raw == null ? "" : raw);
			s = s.replace(/`([^`]+)`/g, (m, code) => {
				slots.push("<code>" + mdEscape(code) + "</code>");
				return "\u0000" + (slots.length - 1) + "\u0001";
			});
			s = mdEscape(s);
			s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, url) => {
				const src = mdImgUrl(url.replace(/&amp;/g, "&"));
				if (!src) return "";
				return '<img src="' + mdEscape(src) + '" alt="' + alt + '" loading="lazy" />';
			});
			s = s.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, text, url) => {
				const u = url.replace(/&amp;/g, "&");
				if (/^(todo|meeting):/i.test(u)) {
					const kind = u.split(":")[0].toLowerCase();
					return '<a href="#" data-tw-link="1" data-kind="' + kind + '" data-id="' + mdEscape(u.slice(kind.length + 1)) + '">' + text + "</a>";
				}
				const safe = mdUrl(u);
				if (!safe) return text;
				return '<a href="' + mdEscape(safe) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
			});
			s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
			s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
			s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
			return s.replace(/\u0000(\d+)\u0001/g, (m, i) => slots[Number(i)] || "");
		}

		const MD_LIST = /^\s*(?:[-*+]|\d+\.)\s+/;
		const MD_BLOCK = /^ {0,3}(?:#{1,6}\s|>|```)/;

		/** 极简 GFM 渲染（纯字符串输出，全部文本已转义，不走 innerHTML 注入）。plain=true 时按纯文本展现。
		 *  opt.baseLine  —— 这段内容在原文档里的起始行号（任务清单的 data-line 要用全局行号）
		 *  opt.hnStart   —— 这段内容之前的标题数（标题 id/data-h 用全文序号，大纲才找得到）
		 *  opt.idPrefix  —— 标题 id 前缀（分块渲染时每块各用各的，避免 id 重复 */
		function mdToHtml(md, plain, opt) {
			const o = opt || {};
			const base = o.baseLine || 0;
			const pre = o.idPrefix || "tw-h-";
			const src = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
			if (plain) return '<div class="tw-plain">' + mdEscape(src).replace(/\n/g, "<br />") + "</div>";
			const lines = src.split("\n");
			const out = [];
			let i = 0;
			let hn = o.hnStart || 0;
			while (i < lines.length) {
				const line = lines[i];
				if (!line.trim()) { i += 1; continue; }
				const fence = line.match(/^ {0,3}```\s*([\w+#.-]*)\s*$/);
				if (fence) {
					const lang = fence[1] || "";
					const buf = [];
					i += 1;
					while (i < lines.length && !/^ {0,3}```/.test(lines[i])) buf.push(lines[i++]);
					i += 1;
					out.push("<pre><code" + (lang ? ' data-lang="' + mdEscape(lang) + '"' : "") + ">" + mdEscape(buf.join("\n")) + '</code><button class="tw-copy" type="button">复制</button></pre>');
					continue;
				}
				const head = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
				if (head) {
					const lv = head[1].length;
					hn += 1;
					out.push("<h" + lv + ' id="' + pre + hn + '" data-h="' + hn + '">' + mdInline(head[2].replace(/\s+#+\s*$/, "")) + "</h" + lv + ">");
					i += 1;
					continue;
				}
				if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr />"); i += 1; continue; }
				if (/^ {0,3}>/.test(line)) {
					const buf = [];
					while (i < lines.length && /^ {0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^ {0,3}> ?/, ""));
					out.push("<blockquote>" + mdToHtml(buf.join("\n"), false) + "</blockquote>");
					continue;
				}
				if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0) {
					const split = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
					const headCells = split(lines[i]);
					const aligns = split(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
					i += 2;
					const rows = [];
					while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(split(lines[i++]));
					let t = "<table><thead><tr>";
					headCells.forEach((c, k) => { t += "<th" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + mdInline(c) + "</th>"; });
					t += "</tr></thead><tbody>";
					rows.forEach((r) => {
						t += "<tr>";
						headCells.forEach((c, k) => { t += "<td>" + mdInline(r[k] == null ? "" : r[k]) + "</td>"; });
						t += "</tr>";
					});
					out.push(t + "</tbody></table>");
					continue;
				}
				if (MD_LIST.test(line)) {
					const items = [];
					while (i < lines.length && MD_LIST.test(lines[i])) {
						const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
						items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d+\./.test(m[2]), text: m[3], line: i, num: /\d+\./.test(m[2]) ? Number(m[2].replace(/\.$/, "")) : null });
						i += 1;
					}
					let html = "";
					const stack = [];
					for (const it of items) {
						let depth = it.indent >= 4 ? 2 : it.indent >= 2 ? 1 : 0;
						depth += 1;
						if (depth > stack.length + 1) depth = stack.length + 1;
						while (stack.length && (stack.length > depth || (stack.length === depth && stack[stack.length - 1].ordered !== it.ordered))) {
							html += stack.pop().ordered ? "</ol>" : "</ul>";
						}
						if (stack.length < depth) {
							html += it.ordered ? "<ol" + (it.num && it.num !== 1 ? ' start="' + it.num + '"' : "") + ">" : "<ul>";
							stack.push({ ordered: it.ordered });
						}
						const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
						if (task) {
							const on = task[1].toLowerCase() === "x";
							html += '<li class="tw-task"><span class="tw-check" data-check="' + (on ? 1 : 0) + '" data-line="' + (it.line + base) + '" role="checkbox" aria-checked="' + (on ? "true" : "false") + '">✓</span><span>' + mdInline(task[2]) + "</span></li>";
						} else {
							html += "<li>" + mdInline(it.text) + "</li>";
						}
					}
					while (stack.length) html += stack.pop().ordered ? "</ol>" : "</ul>";
					out.push(html);
					continue;
				}
				const buf = [];
				while (i < lines.length && lines[i].trim() && !MD_BLOCK.test(lines[i]) && !MD_LIST.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
					buf.push(lines[i++]);
				}
				if (!buf.length) buf.push(lines[i++]);
				out.push("<p>" + mdInline(buf.join("\n")).replace(/\n/g, "<br />") + "</p>");
			}
			return out.join("\n");
		}

		
export { mdEscape, mdUrl, mdImgUrl, mdInline, mdToHtml, MD_CSS };
