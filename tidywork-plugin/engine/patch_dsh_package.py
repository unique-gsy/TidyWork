import json

pkg_path = "C:/Users/dulixuan/.dsh/profiles/desktop/package.json"
plugin_dir = "C:/Users/dulixuan/.dsh/plugins/tidywork-plugin"

with open(pkg_path, "r", encoding="utf-8") as f:
    j = json.load(f)

j.setdefault("dependencies", {})["@tidywork/dsh-plugin"] = "file:" + plugin_dir.replace("\\", "/")
j.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
bundles = j["dsh"]["profile"]["bundles"]
if "@tidywork/dsh-plugin" not in bundles:
    bundles.append("@tidywork/dsh-plugin")

with open(pkg_path, "w", encoding="utf-8") as f:
    json.dump(j, f, ensure_ascii=False, indent=2)
    f.write("\n")

print("OK")
print(json.dumps(j, ensure_ascii=False, indent=2))
