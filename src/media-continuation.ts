/** Replace only Markdown destinations that still equal the captured reference. */
export function replaceMarkdownDestination(markdown: string, from: string, to: string, imageOnly = false) {
  const pattern = /(!?\[[^\]\n]*\]\()(<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;
  return markdown.replace(pattern, (match, prefix: string, rawDestination: string, suffix: string) => {
    if (imageOnly && !prefix.startsWith("!")) return match;
    const destination = rawDestination.startsWith("<") && rawDestination.endsWith(">")
      ? rawDestination.slice(1, -1)
      : rawDestination;
    if (destination !== from) return match;
    const replacement = /\s/.test(to) ? `<${to}>` : to;
    return `${prefix}${replacement}${suffix}`;
  });
}
