import { JSONSchema7 } from 'json-schema';
import { DocumentNode, FieldNode } from 'graphql';
import { reduce, cloneDeep, has, get } from 'lodash';
import { ApolloClient } from "apollo-client";
import { introspectionQuery } from './introspectionQuery';
import { fromIntrospectionQuery } from "graphql-2-json-schema";

export interface FrontierDataGraphQLProps {
  mutation: DocumentNode;
  client?: ApolloClient<any>;
  schema?: JSONSchema7;
  save?: (values: object) => Promise<undefined | object>;
}

export type SchemaFromGraphQLPropsReturn = { schema: JSONSchema7, mutationName: string } | null;
// Given GraphQL data props, return a valid form JSONSchema (or null)
export function schemaFromGraphQLProps (props: FrontierDataGraphQLProps): Promise<SchemaFromGraphQLPropsReturn> {
  if (props.mutation) {
    const mutationName = getMutationNameFromDocumentNode(props.mutation);
    if (!mutationName) {
      return Promise.resolve(null);
    }

    if (props.schema) {
      return Promise.resolve({ schema: buildFormSchema(props.schema, mutationName), mutationName });
    } else if (props.client) {
      return props.client.query({ query: introspectionQuery }).then(result => {
        if (result.errors) {
          console.log(`Unable to fetch GraphQL schema: ${result.errors}`);
          return null;
        } else {
          const schema = fromIntrospectionQuery(result.data) as JSONSchema7;
          // FIXME: update "graphql-2-json-schema" to generate JSONSchema7
          schema.$schema = 'http://json-schema.org/draft-07/schema#';
          return { schema: buildFormSchema(schema, mutationName), mutationName }
        }
      })
    } else {
      return Promise.resolve(null);
    }
  } else {
    return Promise.resolve(null);
  }
}

// perform a mutation operation with given `mutation` and `values`
export function saveData (
  props: FrontierDataGraphQLProps,
  values: object
): Promise<undefined | object> {
  if (!props.client && props.mutation) {
    console.error('Trying to save data with a mutation without providing an ApolloClient!')
    return Promise.reject({});
  } else if (!props.mutation && props.save) {
    return props.save(values);
  } else {
    return props.client!.mutate({
      mutation: props.mutation,
      variables: values
    }).then(result => {
      if (result.errors) {
        // FIXME: find a way to handle GQL errors on mutation arguments
        return {};
      } else {
        return undefined; // submit succeed
      }
    });
  }
}

// Example of `mutation` object:
// {
//   "kind": "Document",
//   "definitions": [
//       {
//           "kind": "OperationDefinition",
//           "operation": "mutation",
//           "name": {
//               "kind": "Name",
//               "value": "updateTodo"
//           },
//           "variableDefinitions": [
//               {
//                   "kind": "VariableDefinition",
//                   "variable": {
//                       "kind": "Variable",
//                       "name": {
//                           "kind": "Name",
//                           "value": "todo"
//                       }
//                   },
//                   "type": {
//                       "kind": "NonNullType",
//                       "type": {
//                           "kind": "NamedType",
//                           "name": {
//                               "kind": "Name",
//                               "value": "TodoInputType"
//                           }
//                       }
//                   },
//                   "directives": []
//               }
//           ],
//           "directives": [],
//           "selectionSet": {
//               "kind": "SelectionSet",
//               "selections": [
//                   {
//                       "kind": "Field",
//                       "name": {
//                           "kind": "Name",
//                           "value": "update_todo"
//                       },
//                       "arguments": [
//                           {
//                               "kind": "Argument",
//                               "name": {
//                                   "kind": "Name",
//                                   "value": "todo"
//                               },
//                               "value": {
//                                   "kind": "Variable",
//                                   "name": {
//                                       "kind": "Name",
//                                       "value": "todo"
//                                   }
//                               }
//                           }
//                       ],
//                       "directives": [],
//                       "selectionSet": {
//                           "kind": "SelectionSet",
//                           "selections": [
//                               {
//                                   "kind": "FragmentSpread",
//                                   "name": {
//                                       "kind": "Name",
//                                       "value": "Todo"
//                                   },
//                                   "directives": []
//                               }
//                           ]
//                       }
//                   }
//               ]
//           }
//       }
//   ],
//   "loc": {
//       "start": 0,
//       "end": 137
//   }
// }
export function getMutationNameFromDocumentNode (mutation: DocumentNode): string | null {
  if (mutation.definitions.length > 1) {
    console.warn("please provide 1 mutation document")
    return null;
  } else {
    const definition = mutation.definitions[0];
    if (definition.kind === 'OperationDefinition' && definition.operation === 'mutation') {
      if (definition.selectionSet.selections.length == 1 && definition.selectionSet.selections[0].kind === 'Field') {
        const selection = definition.selectionSet.selections[0] as FieldNode;
        if (!selection.name) {
          console.warn("please provide a named mutation")
          return null;
        } else {
          return selection.name.value;
        }
      } else {
        console.warn(`please provide a valid mutation definition`);
        return null;
      }
    } else {
      console.warn(`please provide a mutation document, received a ${definition.kind === 'OperationDefinition' ? definition.operation : definition.kind} document`)
      return null;
    }
  }
}

// Given a GraphQL schema JSON Schema and a mutation, return a form schema
export function buildFormSchema (schema: JSONSchema7, mutationName: string): JSONSchema7 {
  const mutationSchema = (schema.properties!.Mutation as JSONSchema7).properties![mutationName] as JSONSchema7;
  if (!mutationSchema) {
    console.warn(`Unknown mutation ${mutationName} provided`)
    return {};
  }

  const args = mutationSchema.properties!.arguments as JSONSchema7;
  if (args && args.properties && Object.keys(args.properties).length > 0) {
    return formPropertiesReducer(args, schema);
  } else {
    console.warn(`mutation ${mutationName} has no arguments`)
    return {};
  }
}

function formPropertiesReducer (schema, referenceSchema): JSONSchema7 {
  return {
    type: 'object',
    properties: reduce<JSONSchema7, { [k: string]: any }>(
      schema.properties,
      (result, value, key) => {
        if (get(value, '$ref')) {
          const refTypeName = get(value, '$ref')!.replace('#/definitions/', '');
          const refType = referenceSchema.definitions[refTypeName];
          if (!refType) {
            console.warn(`unknown $ref "${refTypeName}" for ${key}`);
          }
          result[key] = refType ? cloneDeep(formPropertiesReducer(refType, referenceSchema)) : {};
        } else {
          result[key] = has(value, 'properties') ?
            { ...value, properties: formPropertiesReducer(value, referenceSchema) }
            : value;
        }
        return result;
      },
      {}
    ),
    required: schema.required
  }
}
