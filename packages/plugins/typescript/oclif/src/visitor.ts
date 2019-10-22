import { ClientSideBaseVisitor, ClientSideBasePluginConfig, LoadedFragment, getConfigValue, OMIT_TYPE, indentMultiline, RawClientSideBasePluginConfig } from '@graphql-codegen/visitor-plugin-common';
import * as autoBind from 'auto-bind';
import { GraphQLNamedType, GraphQLSchema, NamedTypeNode, OperationDefinitionNode, print, TypeNode, VariableDefinitionNode } from 'graphql';
import { join, resolve } from 'path';

import { Config, Info } from '.';

interface Operation {
  node: OperationDefinitionNode;
  documentVariableName: string;
  operationType: string;
  operationResultType: string;
  operationVariablesTypes: string;
}

interface OclifDirectiveValues {
  description?: string;
  examples?: string[];
}

const oclifDirectiveKeys: Array<keyof OclifDirectiveValues> = ['description', 'examples'];

export class GraphQLRequestVisitor extends ClientSideBaseVisitor<Config, ClientSideBasePluginConfig> {
  private _operationsToInclude: Operation[] = [];
  private _info: Info;

  constructor(schema: GraphQLSchema, fragments: LoadedFragment[], rawConfig: Config, info: Info) {
    super(schema, fragments, rawConfig, {});
    this._info = info;

    const { clientPath = '../../client' } = rawConfig;
    // FIXME: This is taken in part from
    //  presets/near-operation-file/src/index.ts:139. How do I build a path relative to the outputFile in the same way?
    //  A plugin doesn't appear to have access to the same "options.baseOutputDir" that this preset does.
    // const absClientPath = resolve(info.outputFile, join(options.baseOutputDir, options.presetConfig.baseTypesPath));

    autoBind(this);
    this._additionalImports.push(`import { Command, flags } from '@oclif/command'`);
    this._additionalImports.push(`import client from '${clientPath}'`);
  }

  protected buildOperation(node: OperationDefinitionNode, documentVariableName: string, operationType: string, operationResultType: string, operationVariablesTypes: string): string {
    this._operationsToInclude.push({
      node,
      documentVariableName,
      operationType,
      operationResultType,
      operationVariablesTypes,
    });

    return null;
  }

  // Clean client-side content (ie directives) out of the GraphQL document prior to sending to the server
  public get definition(): string {
    const operation = this._operationsToInclude[0];
    const clientOperation = print(omitOclifDirectives(operation.node));
    return `const ${operation.documentVariableName} = \`\n${clientOperation}\``;
  }

  // Generate the code required for this CLI operation
  public get cliContent(): string {
    if (this._operationsToInclude.length !== 1) {
      throw new Error(`Each graphql document should have exactly one operation; found ${this._operationsToInclude.length} while generating ${this._info.outputFile}.`);
    }

    const operation = this._operationsToInclude[0];
    const resultType = this._schema.getType(operation.operationResultType);

    // Find the @oclif directive in the client document, if it's there
    const directive = operation.node.directives.find(directive => directive.name.value === 'oclif');

    // Remap the directive's fields ie @oclif(description: "a name") to a more usable format
    const directiveValues: OclifDirectiveValues = {};

    if (directive) {
      directiveValues.examples = [];
      directive.arguments.forEach(arg => {
        // @ts-ignore ts doesn't like arg.value.value, there's a mis-typing in there to address
        const { value } = arg.value;
        const { value: name } = arg.name;
        if (name === 'description') {
          directiveValues[name] = value;
        } else if (name === 'example') {
          directiveValues.examples.push(value);
        } else {
          throw new Error(`Invalid field supplied to @oclif directive: ${name}`);
        }
      });
    }

    const { description, examples } = directiveValues;

    const flags = operation.node.variableDefinitions.map(getFlagConfigForVariableDefinition);

    return `
${this.definition}

export default class ${operation.node.name.value} extends Command {
  ${description ? `\nstatic description = "${description}";\n` : ''}
  ${examples ? `\nstatic examples: string[] = ${JSON.stringify(examples)};\n` : ''}
  static flags = {
    help: flags.help({ char: 'h' }),
${indentMultiline(flags.join(',\n'), 2)}
  };

  async run() {
    const { flags } = this.parse(${operation.node.name.value});
    client.request(${operation.documentVariableName}, flags)
      .then(data => {
        this.log(JSON.stringify(data, null, 2));
      })
      .catch(error => {
        console.log(error.response.data);
        console.error(error.response.errors.map((e: Error) => e.message).join("\\n"));
      });
  }
}
`;
  }
}

type OclifFlagType = 'boolean' | 'integer' | 'string' | 'enum';

// TODO: Implement enum
const mapVariableTypeToOclifType = (type: NamedTypeNode): OclifFlagType => {
  if (type.name.value === 'Boolean') {
    return 'boolean';
  } else if (['Float', 'Int'].includes(type.name.value)) {
    // A quirk of oclif is that "integer" allows for a `number`-typed response, and then
    //   we supply our own parsing function to make sure it's a float and not an integer
    return 'integer';
  } else {
    return 'string';
  }
};

const getParserForType = (type: NamedTypeNode): string | void => {
  if (type.name.value === 'Float') {
    return 'input => Number(input)';
  }
};

const getFlagConfigForVariableDefinition = (definition: VariableDefinitionNode) => {
  const { list, required, innerType } = getInnerType(definition.type);
  const oclifType = mapVariableTypeToOclifType(innerType);
  const parser = getParserForType(innerType);

  return `${definition.variable.name.value}: flags.${oclifType}({
  multiple: ${list},
  required: ${required},${parser ? `\n  parse: ${parser}` : ''}
})`;
};

interface TypeConfig {
  required: boolean;
  list: boolean;
  innerType: NamedTypeNode;
}

const getInnerType = (type: TypeNode): TypeConfig => {
  let result: Partial<TypeConfig> = {
    list: false,
    required: false,
  };
  let _type = type;
  while (_type.kind !== 'NamedType') {
    if (_type.kind === 'ListType') {
      result.list = true;
    } else if (_type.kind === 'NonNullType') {
      result.required = true;
    }
    _type = _type.type;
  }
  result.innerType = _type;
  return result as TypeConfig;
};

// remove all @oclif directives from the document for transmission to the server
const omitOclifDirectives = (node: OperationDefinitionNode) => {
  const directives = node.directives.filter(directive => directive.name.value !== 'oclif');
  return Object.assign({}, node, { directives });
};
