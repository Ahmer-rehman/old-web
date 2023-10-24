#!/usr/bin/env -S npx ts-node

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import parseArgs from "minimist";

const argv = parseArgs(process.argv.slice(2), {
    string: ["on"],
    boolean: ["debug"],
});

class IdGenerator {
    private id = 10;
    private map = new Map<string, string>();

    public get(s: string): string {
        if (this.map.has(s)) return this.map.get(s)!;
        const id = this.id.toString(36).toLowerCase();
        this.map.set(s, id);
        this.id++;
        return id;
    }

    public debug(): void {
        console.log("```");
        console.log(this.map);
        console.log("```");
    }
}

interface Node {
    // Workflows are keyed by name??id
    // Jobs are keyed by id
    // Triggers are keyed by id
    id: string;
    name: string;
    shape:
        | "round edges"
        | "stadium"
        | "subroutine"
        | "cylinder"
        | "circle"
        | "flag"
        | "rhombus"
        | "hexagon"
        | "parallelogram"
        | "parallelogram_alt"
        | "trapezoid"
        | "trapezoid_alt"
        | "double_circle";
    link?: string;
}

class Graph<T extends Node> {
    public nodes = new Map<string, T>();
    public edges: [source: T, destination: T, label?: string][] = [];

    public addNode(node: T): void {
        if (!this.nodes.has(node.id)) {
            this.nodes.set(node.id, node);
        }
    }

    public addEdge(source: T, destination: T, label?: string): void {
        if (this.edges.some(([_source, _destination]) => _source === source && _destination === destination)) return;
        this.edges.push([source, destination, label]);
    }

    // Removes nodes without any edges
    public cull(): void {
        const seenNodes = new Set<Node>();
        graph.edges.forEach(([source, destination]) => {
            seenNodes.add(source);
            seenNodes.add(destination);
        });
        graph.nodes.forEach((node) => {
            if (!seenNodes.has(node)) {
                graph.nodes.delete(node.id);
            }
        });
    }

    public get roots(): Set<T> {
        const roots = new Set(this.nodes.values());
        this.edges.forEach(([source, destination]) => {
            roots.delete(destination);
        });
        return roots;
    }

    public search(root: T, fn: (node: T) => void): void {
        fn(root);
        this.edges.forEach(([source, destination]) => {
            if (source === root) {
                this.search(destination, fn);
            }
        });
    }

    public get connectedSubgraphs(): Graph<T>[] {
        return [...this.roots].map((root) => {
            const graph = new Graph<T>();

            this.search(root, (node) => {
                graph.addNode(node);
                this.edges.forEach((edge) => {
                    if (edge[0] === node) {
                        graph.addEdge(...edge);
                    }
                });
            });

            return graph;
        });
    }
}

interface Project {
    url: string;
    name: string;
    path: string;
    workflows: Map<string, Workflow>;
}

interface Workflow extends Node {
    path: string;
    project: Project;
    jobs: Job[];
    on: WorkflowYaml["on"];
}

interface Job extends Node {
    id: string;
    needs?: string[];
    strategy?: {
        matrix: {
            [key: string]: string[];
        } & {
            include?: Record<string, string>[];
            exclude?: Record<string, string>[];
        };
    };
}

interface WorkflowYaml {
    name: string;
    on: {
        workflow_run?: {
            workflows: string[];
        }; // Magic
        workflow_call?: {}; // Reusable
        workflow_dispatch?: {}; // Manual
        pull_request?: {};
        merge_group?: {};
        push?: {
            tags?: string[];
            branches?: string[];
        };
        schedule?: { cron: string }[];
        release?: {};
        //
        label?: {};
        issues?: {};
    };
    jobs: {
        [job: string]: {
            name?: string;
            needs?: string | string[];
            strategy?: Job["strategy"];
        };
    };
}

type Trigger = Node;

/* eslint-disable @typescript-eslint/naming-convention */
const TRIGGERS: {
    [key in keyof WorkflowYaml["on"]]: (
        data: NonNullable<WorkflowYaml["on"][key]>,
        workflow: Workflow,
    ) => Trigger | Trigger[];
} = {
    workflow_dispatch: () => ({
        id: "on:workflow_dispatch",
        name: "Manual",
        shape: "circle",
    }),
    issues: (_, { project }) => ({ id: `on:issues/${project.name}`, name: `${project.name} Issues`, shape: "circle" }),
    label: (_, { project }) => ({ id: "on:label", name: "on: Label", shape: "circle" }),
    release: (_, { project }) => ({
        id: `on:release/${project.name}`,
        name: `${project.name} Release`,
        shape: "circle",
    }),
    push: (data, { project }) => {
        const nodes: Trigger[] = [];
        data.tags?.forEach((tag) => {
            const name = `Push ${project.name}<br>tag ${tag}`;
            nodes.push({ id: `on:push/${project.name}/tag/${tag}`, name, shape: "circle" });
        });
        data.branches?.forEach((branch) => {
            const name = `Push ${project.name}<br>${branch}`;
            nodes.push({ id: `on:push/${project.name}/branch/${branch}`, name, shape: "circle" });
        });
        return nodes;
    },
    schedule: (data) =>
        data.map(({ cron }) => ({
            id: `on:schedule/${cron}`,
            name: `Schedule<br>${cron}`,
            shape: "circle",
        })),
    pull_request: (_, { project }) => ({
        id: `on:pull_request/${project.name}`,
        name: `Pull Request<br>${project.name}`,
        shape: "circle",
    }),
};
/* eslint-enable @typescript-eslint/naming-convention */

const triggers = new Map<string, Trigger>();
const projects = new Map<string, Project>();
const workflows = new Map<string, Workflow>();

function getTriggerNodes<K extends keyof WorkflowYaml["on"]>(key: K, workflow: Workflow): Trigger[] {
    if (!TRIGGERS[key]) return [];
    const data = workflow.on[key]!;
    const nodes = toArray(TRIGGERS[key]!(data, workflow));
    return nodes.map((node) => {
        if (triggers.has(node.id)) return triggers.get(node.id)!;
        triggers.set(node.id, node);
        return node;
    });
}

function readFile(...pathSegments: string[]): string {
    return fs.readFileSync(path.join(...pathSegments), { encoding: "utf-8" });
}

function readJson<T extends object>(...pathSegments: string[]): T {
    return JSON.parse(readFile(...pathSegments));
}

function readYaml<T extends object>(...pathSegments: string[]): T {
    return YAML.parse(readFile(...pathSegments));
}

function toArray<T>(v: T | T[]): T[] {
    return Array.isArray(v) ? v : [v];
}

function cartesianProduct<T>(sets: T[][]): T[][] {
    return sets.reduce<T[][]>(
        (results, ids) =>
            results
                .map((result) => ids.map((id) => [...result, id]))
                .reduce((nested, result) => [...nested, ...result]),
        [[]],
    );
}

function shallowCompare(obj1: Record<string, any>, obj2: Record<string, any>): boolean {
    return (
        Object.keys(obj1).length === Object.keys(obj2).length &&
        Object.keys(obj1).every((key) => obj1[key] === obj2[key])
    );
}

// Data ingest
for (const projectPath of argv._) {
    const {
        name,
        repository: { url },
    } = readJson<{ name: string; repository: { url: string } }>(projectPath, "package.json");
    const workflowsPath = path.join(projectPath, ".github", "workflows");

    const project: Project = {
        name,
        url,
        path: projectPath,
        workflows: new Map(),
    };

    for (const file of fs.readdirSync(workflowsPath).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
        const data = readYaml<WorkflowYaml>(workflowsPath, file);
        const name = data.name ?? file;
        const workflow: Workflow = {
            id: name,
            name,
            shape: "hexagon",
            path: path.join(workflowsPath, file),
            project,
            link: `${project.url}/blob/develop/.github/workflows/${file}`,

            on: data.on,
            jobs: [],
        };

        for (const jobId in data.jobs) {
            const job = data.jobs[jobId];
            workflow.jobs.push({
                id: jobId,
                name: job.name ?? jobId,
                strategy: job.strategy,
                needs: job.needs ? toArray(job.needs) : undefined,
                shape: "subroutine",
                link: `${project.url}/blob/develop/.github/workflows/${file}`,
            });
        }

        project.workflows.set(name, workflow);
        workflows.set(name, workflow);
    }

    projects.set(name, project);
}

class MermaidFlowchartPrinter {
    private static INDENT = 4;
    private currentIndent = 0;
    private text = "";
    public readonly idGenerator = new IdGenerator();

    private print(text: string): void {
        this.text += " ".repeat(this.currentIndent) + text + "\n";
    }

    public finish(): void {
        this.indent(-1);
        if (this.markdown) this.print("```\n");
        console.log(this.text);
    }

    private indent(delta = 1): void {
        this.currentIndent += delta * MermaidFlowchartPrinter.INDENT;
    }

    public constructor(direction: "TD" | "TB" | "BT" | "RL" | "LR", private readonly markdown = false) {
        if (this.markdown) {
            this.print("```mermaid");
            this.print("---");
            this.print(`title: Test`); // TODO
            this.print("---");
        }
        // Print heading
        this.print(`flowchart ${direction}`);
        this.indent();
    }

    public subgraph(name: string, fn: () => void): void {
        const id = this.idGenerator.get(name);
        this.print(`subgraph ${id}["${name}"]`);
        this.indent();
        fn();
        this.indent(-1);
        this.print("end");
    }

    public node(node: Node): void {
        const id = this.idGenerator.get(node.id);
        const name = node.name.replaceAll('"', "'");
        switch (node.shape) {
            case "round edges":
                this.print(`${id}("${name}")`);
                break;
            case "stadium":
                this.print(`${id}(["${name}"])`);
                break;
            case "subroutine":
                this.print(`${id}[["${name}"]]`);
                break;
            case "cylinder":
                this.print(`${id}[("${name}")]`);
                break;
            case "circle":
                this.print(`${id}(("${name}"))`);
                break;
            case "flag":
                this.print(`${id}>"${name}"]`);
                break;
            case "rhombus":
                this.print(`${id}{"${name}"}`);
                break;
            case "hexagon":
                this.print(`${id}{{"${name}"}}`);
                break;
            case "parallelogram":
                this.print(`${id}[/"${name}"/]`);
                break;
            case "parallelogram_alt":
                this.print(`${id}[\\"${name}"\\]`);
                break;
            case "trapezoid":
                this.print(`${id}[/"${name}"\\]`);
                break;
            case "trapezoid_alt":
                this.print(`${id}[\\"${name}"/]`);
                break;
            case "double_circle":
                this.print(`${id}((("${name}")))`);
                break;
        }

        if (node.link) {
            this.print(`click ${id} href "${node.link}" "Click to open workflow"`);
        }
    }

    public edge(source: Node, destination: Node, text?: string): void {
        const sourceId = this.idGenerator.get(source.id);
        const destinationId = this.idGenerator.get(destination.id);
        if (text) {
            this.print(`${sourceId}-- ${text} -->${destinationId}`);
        } else {
            this.print(`${sourceId} --> ${destinationId}`);
        }
    }
}

const graph = new Graph<Workflow | Node>();
for (const workflow of workflows.values()) {
    if (typeof argv.on === "string" && !(argv.on in workflow.on)) continue;

    Object.keys(workflow.on).forEach((trigger) => {
        const nodes = getTriggerNodes(trigger as keyof WorkflowYaml["on"], workflow);
        nodes.forEach((node) => {
            graph.addNode(node);
            graph.addEdge(node, workflow);
        });
    });

    workflow.on.workflow_run?.workflows.forEach((parent) => {
        graph.addEdge(workflows.get(parent)!, workflow);
    });
}

graph.cull();
graph.connectedSubgraphs.forEach((graph) => {
    const printer = new MermaidFlowchartPrinter("LR", true);
    graph.nodes.forEach((node) => {
        if ("project" in node) {
            // TODO unsure about this edge
            // if (Object.keys(node.jobs).length === 1) {
            //     printer.node(node.name, node.shape, link);
            //     return;
            // }

            // TODO handle job.if on github.event_name

            const subgraph = new Graph<Job>();
            for (const job of node.jobs) {
                subgraph.addNode(job);
                if (job.needs) {
                    toArray(job.needs).forEach((req) => {
                        subgraph.addEdge(node.jobs.find((job) => job.id === req)!, job, "needs");
                    });
                }
            }

            printer.subgraph(node.name, () => {
                subgraph.nodes.forEach((node) => {
                    printer.node(node);
                });

                subgraph.edges.forEach(([source, destination, text]) => {
                    printer.edge(source, destination, text);
                });

                subgraph.roots.forEach((job) => {
                    if (!job.strategy?.matrix) {
                        printer.node(job);
                        return;
                    }

                    let variations: { [p: string]: string }[] = [{}];
                    if (job.strategy?.matrix) {
                        variations = cartesianProduct(
                            Object.keys(job.strategy.matrix)
                                .filter((key) => key !== "include" && key !== "exclude")
                                .map((matrixKey) => {
                                    return job.strategy!.matrix[matrixKey].map((value) => ({ [matrixKey]: value }));
                                }),
                        )
                            .map((variation) => Object.assign({}, ...variation))
                            .filter((variation) => Object.keys(variation).length > 0);

                        if (job.strategy.matrix.include) {
                            variations.push(...job.strategy.matrix.include);
                        }
                        if (job.strategy.matrix.exclude) {
                            job.strategy.matrix.exclude.forEach((exclusion) => {
                                variations = variations.filter((variation) => {
                                    return !shallowCompare(exclusion, variation);
                                });
                            });
                        }
                    }

                    // TODO validate edge case
                    if (variations.length === 0) {
                        printer.node(job);
                        return;
                    }

                    printer.subgraph(job.name, () => {
                        variations.forEach((variation) => {
                            let variationName = job.name;
                            if (variationName.includes("${{ matrix.")) {
                                Object.keys(variation).map((key) => {
                                    variationName = variationName.replace(`\${{ matrix.${key} }}`, variation[key]);
                                });
                            } else {
                                variationName = `${variationName} (${Object.values(variation).join(", ")})`;
                            }

                            printer.node({ ...job, name: variationName });
                        });
                    });
                });
            });
            return;
        }

        printer.node(node);
    });
    graph.edges.forEach(([sourceName, destinationName, text]) => {
        printer.edge(sourceName, destinationName, text);
    });
    printer.finish();

    if (argv.debug) {
        printer.idGenerator.debug();
    }
});
