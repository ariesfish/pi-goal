export function matchGlob(filePath: string, glob: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(normalizedGlob).test(normalizedPath);
}

function globToRegExp(glob: string): RegExp {
  let result = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      result += "[^/]";
      continue;
    }
    result += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${result}$`);
}
