import { ChevronDown, ChevronRight, Columns, Database, Table } from "lucide-react";
import { useState } from "react";
import { SchemaNode, SchemaNodeKind } from "../lib/tauri";

interface Props {
  nodes: SchemaNode[];
  onTableClick?: (tableName: string) => void;
}

function NodeIcon({ kind }: { kind: SchemaNodeKind }) {
  if (kind === "Schema" || kind === "Database") return <Database size={13} />;
  if (kind === "Table") return <Table size={13} />;
  return <Columns size={13} />;
}

function TreeNode({
  node,
  onTableClick,
}: {
  node: SchemaNode;
  onTableClick?: (t: string) => void;
}) {
  const [open, setOpen] = useState(node.kind === "Schema");
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <button
        className={`tree-node kind-${node.kind.toLowerCase()}`}
        onClick={() => {
          if (hasChildren) setOpen((o) => !o);
          if (node.kind === "Table" && onTableClick) onTableClick(node.name);
        }}
      >
        {hasChildren ? (
          open ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span className="tree-spacer" />
        )}
        <NodeIcon kind={node.kind} />
        <span>{node.name}</span>
      </button>
      {open && hasChildren && (
        <ul>
          {node.children.map((child) => (
            <TreeNode key={child.name} node={child} onTableClick={onTableClick} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SchemaTree({ nodes, onTableClick }: Props) {
  return (
    <div className="schema-tree">
      <ul>
        {nodes.map((n) => (
          <TreeNode key={n.name} node={n} onTableClick={onTableClick} />
        ))}
      </ul>
    </div>
  );
}
