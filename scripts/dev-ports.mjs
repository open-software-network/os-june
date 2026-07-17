export async function chooseDevPort({ name, explicitValue, base, portIsFree, scanLength = 100 }) {
  const explicit = Number.parseInt(explicitValue ?? "", 10);
  if (explicitValue !== undefined && explicitValue !== "") {
    if (!Number.isInteger(explicit) || explicit <= 0 || explicit > 65_535) {
      throw new Error(`${name} port must be an integer between 1 and 65535.`);
    }
    if (!(await portIsFree(explicit))) {
      throw new Error(`${name} port ${explicit} is already in use.`);
    }
    return explicit;
  }

  for (let port = base; port < base + scanLength; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free ${name} port found in ${base}..${base + scanLength - 1}.`);
}
