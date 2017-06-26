const { GraphQLNonNull, GraphQLList, GraphQLString } = require("graphql");
const queryFromResolveData = require("../queryFromResolveData");
const firstValue = obj => {
  let firstKey;
  for (const k in obj) {
    firstKey = k;
  }
  return obj[firstKey];
};

module.exports = function makeProcField(
  fieldName,
  proc,
  {
    buildFieldWithHooks,
    computed,
    strictFunctions,
    introspectionResultsByKind,
    gqlTypeByTypeId,
    gqlInputTypeByTypeId,
    getTypeByName,
    inflection,
    sql,
    parseResolveInfo,
    gql2pg,
    pg2gql,
  }
) {
  const sliceAmount = computed ? 1 : 0;
  const argNames = proc.argTypeIds
    .map((_, idx) => proc.argNames[idx] || "")
    .slice(sliceAmount);
  const argTypes = proc.argTypeIds
    .slice(sliceAmount)
    .map(typeId => introspectionResultsByKind.typeById[typeId]);
  const requiredArgs = Math.max(
    0,
    proc.isStrict
      ? proc.argNames.length - sliceAmount
      : strictFunctions
        ? proc.argNames.length - sliceAmount - proc.argDefaultsNum
        : 0
  );
  const argGqlTypes = argTypes.map((type, idx) => {
    const Type = gqlInputTypeByTypeId[type.id] || GraphQLString;
    if (idx >= requiredArgs) {
      return Type;
    } else {
      return new GraphQLNonNull(Type);
    }
  });

  const returnType = introspectionResultsByKind.typeById[proc.returnTypeId];
  const returnTypeTable =
    introspectionResultsByKind.classById[returnType.classId];
  if (!returnType) {
    throw new Error(
      `Could not determine return type for function '${proc.name}'`
    );
  }
  const returnTypeTableAttributes =
    returnTypeTable &&
    introspectionResultsByKind.attribute.filter(
      attr => attr.classId === returnTypeTable.id
    );
  const returnTypeTablePrimaryKeyConstraint =
    returnTypeTable &&
    introspectionResultsByKind.constraint
      .filter(con => con.classId === returnTypeTable.id)
      .filter(con => ["p"].includes(con.type))[0];
  const returnTypeTablePrimaryKeys =
    returnTypeTablePrimaryKeyConstraint &&
    returnTypeTablePrimaryKeyConstraint.keyAttributeNums.map(
      num => returnTypeTableAttributes.filter(attr => attr.num === num)[0]
    );

  let type;
  const scope = {};
  let returnFirstValueAsValue = false;
  if (returnTypeTable) {
    const TableType = getTypeByName(
      inflection.tableType(returnTypeTable.name, returnTypeTable.namespace.name)
    );
    if (proc.returnsSet) {
      const ConnectionType = getTypeByName(
        inflection.connection(TableType.name)
      );
      type = new GraphQLNonNull(ConnectionType);
      scope.isPgConnectionField = true;
      scope.pgIntrospection = returnTypeTable;
    } else {
      type = TableType;
      scope.pgIntrospection = returnTypeTable;
    }
  } else {
    returnFirstValueAsValue = true;
    const Type = gqlTypeByTypeId[returnType.id] || GraphQLString;
    if (proc.returnsSet) {
      type = new GraphQLList(new GraphQLNonNull(Type));
    } else {
      type = Type;
    }
  }
  return buildFieldWithHooks(
    fieldName,
    ({ addDataGenerator, getDataFromParsedResolveInfoFragment }) => {
      function makeQuery(
        parsedResolveInfoFragment,
        { implicitArgs = [] } = {}
      ) {
        const resolveData = getDataFromParsedResolveInfoFragment(
          parsedResolveInfoFragment
        );
        const { args = {} } = parsedResolveInfoFragment;
        const argValues = argNames.map((argName, argIndex) => {
          const gqlArgName = inflection.argument(argName, argIndex);
          return gql2pg(args[gqlArgName], argTypes[argIndex]);
        });
        while (
          argValues.length > requiredArgs &&
          argValues[argValues.length - 1] == null
        ) {
          argValues.pop();
        }
        const functionAlias = Symbol();
        return queryFromResolveData(
          sql.fragment`${sql.identifier(
            proc.namespace.name,
            proc.name
          )}(${sql.join([...implicitArgs, ...argValues.map(sql.value)], ",")})`,
          functionAlias,
          resolveData,
          { asJsonAggregate: proc.returnsSet, asJson: true },
          innerQueryBuilder => {
            if (returnTypeTablePrimaryKeys) {
              innerQueryBuilder.beforeFinalize(() => {
                // append order by primary key to the list of orders
                returnTypeTablePrimaryKeys.forEach(key => {
                  innerQueryBuilder.orderBy(
                    sql.fragment`${sql.identifier(functionAlias, key.name)}`,
                    true
                  );
                });
              });
            }
          }
        );
      }
      if (computed) {
        addDataGenerator(parsedResolveInfoFragment => {
          return {
            pgQuery: queryBuilder => {
              queryBuilder.select(() => {
                const parentTableAlias = queryBuilder.getTableAlias();
                const query = makeQuery(parsedResolveInfoFragment, {
                  implicitArgs: [sql.identifier(parentTableAlias)],
                });
                return sql.fragment`(${query})`;
              }, parsedResolveInfoFragment.alias);
            },
          };
        });
      }
      return {
        type: type,
        args: argNames.reduce((memo, argName, argIndex) => {
          const gqlArgName = inflection.argument(argName, argIndex);
          memo[gqlArgName] = {
            type: argGqlTypes[argIndex],
          };
          return memo;
        }, {}),
        resolve: computed
          ? (data, _args, _context, resolveInfo) => {
              const { alias } = parseResolveInfo(resolveInfo, {
                deep: false,
              });
              const value = data[alias];
              if (returnFirstValueAsValue) {
                if (proc.returnsSet) {
                  return value.map(firstValue).map(v => pg2gql(v, returnType));
                } else {
                  return pg2gql(value, returnType);
                }
              } else {
                return value;
              }
            }
          : async (data, args, { pgClient }, resolveInfo) => {
              const parsedResolveInfoFragment = parseResolveInfo(resolveInfo);
              const query = makeQuery(parsedResolveInfoFragment, {});

              const { text, values } = sql.compile(query);
              console.log(require("sql-formatter").format(text));
              const { rows: r } = await pgClient.query(text, values);
              const rows = r || [];
              if (rows.length === 0) {
                return proc.returnsSet ? [] : null;
              }
              if (returnFirstValueAsValue) {
                if (proc.returnsSet) {
                  return rows.map(firstValue).map(v => pg2gql(v, returnType));
                } else {
                  return pg2gql(firstValue(rows[0]), returnType);
                }
              } else {
                if (proc.returnsSet) {
                  return rows;
                } else {
                  return rows[0];
                }
              }
            },
      };
    },
    scope
  );
};
