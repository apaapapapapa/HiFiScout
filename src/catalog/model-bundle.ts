import { normalizeManufacturer, splitKnownManufacturerModel } from "./manufacturers.js";

export interface ModelBundleComponent {
  segment: string;
  manufacturerId: string;
  manufacturer: string;
  model: string;
}

export interface ModelBundle {
  components: ModelBundleComponent[];
  groupedManufacturers: boolean;
}

/** Explicit '+' bundles only. A suffix such as MC-3+USB or NEO+α is one model. */
export function splitModelBundle(value: string): ModelBundle | null {
  if (!/[+＋]/u.test(value)) return null;
  const parts = value.normalize("NFKC").split(/\s*\+\s*/u);
  if (parts.length < 2 || parts.length > 8 || parts.some((part) => !part.trim())) return null;

  // Sellers also write the manufacturers first: THORENS+JELCO TD-321+SA-750.
  // Pair them only when every manufacturer is known and the two counts agree.
  const manufacturers: { id: string; displayName: string }[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const exact = normalizeManufacturer(parts[index]);
    if (exact.matchedAlias) {
      manufacturers.push(exact);
      continue;
    }
    if (!manufacturers.length) break;
    const last = splitKnownManufacturerModel(parts[index]);
    if (!last?.model) return null;
    manufacturers.push(last);
    const models = [last.model, ...parts.slice(index + 1)];
    if (models.length !== manufacturers.length || !models.every(modelComponent)) return null;
    return {
      groupedManufacturers: true,
      components: models.map((model, position) => ({
        segment: model,
        manufacturerId: manufacturers[position].id,
        manufacturer: manufacturers[position].displayName,
        model,
      })),
    };
  }

  const components = parts.map((part) => {
    const known = splitKnownManufacturerModel(part);
    return {
      segment: part.trim(),
      manufacturerId: known?.model ? known.id : "",
      manufacturer: known?.model ? known.displayName : "",
      model: known?.model || part.trim(),
    };
  });
  if (!components.every((component) => modelComponent(component.model))) return null;
  return { components, groupedManufacturers: false };
}

function modelComponent(value: string): boolean {
  // Require model evidence on both sides, keeping upgrades/connectors/revision suffixes intact.
  return /\d/u.test(value) && /[A-Za-z]/u.test(value) && value.length <= 160;
}
