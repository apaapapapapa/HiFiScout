import type { CatalogRelationProof, ProductModelRelations } from "../src/api/contracts.js";
import { MODEL_RELATION_LABELS } from "./model-relations.js";
import { productPermalinkPath } from "./product-permalink.js";

function Proof({ proof }: { proof: CatalogRelationProof }) {
  return (
    <small className="model-relation-proof">
      {proof.kind === "source" && proof.sourceUrl ? (
        <a href={proof.sourceUrl} target="_blank" rel="noopener noreferrer">
          出典
        </a>
      ) : (
        "手動確認"
      )}
      {" · "}
      <time dateTime={proof.verifiedAt}>
        {new Date(proof.verifiedAt).toLocaleDateString("ja-JP")}
      </time>
    </small>
  );
}

export function ModelRelations({
  relations,
  currentKey,
}: {
  relations: ProductModelRelations;
  currentKey: string;
}) {
  return (
    <div className="model-relations">
      {relations.links.length ? (
        <ul>
          {relations.links.map((link) => (
            <li key={`${link.kind}:${link.key}`}>
              {MODEL_RELATION_LABELS[link.kind]}：
              <a href={productPermalinkPath(link.key) || "/"}>
                {link.manufacturer} {link.model}
              </a>
              <Proof proof={link.proof} />
            </li>
          ))}
        </ul>
      ) : null}
      {relations.families.map((family) => (
        <div key={family.name}>
          <p>
            シリーズ：{family.name} <Proof proof={family.proof} />
          </p>
          <ul>
            {family.members.map((member) => (
              <li key={member.key}>
                {member.key === currentKey ? (
                  <span aria-current="true">{member.model}（この製品）</span>
                ) : (
                  <a href={productPermalinkPath(member.key) || "/"}>
                    {member.manufacturer} {member.model}
                  </a>
                )}
                <Proof proof={member.proof} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
