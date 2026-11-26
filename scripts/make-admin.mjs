// Da (o quita) el rol de administrador a una cuenta. Sirve para nombrar al primer administrador;
// después, los administradores pueden nombrar a otros desde el panel (#/admin).
//
// Local (SQLite):  node scripts/make-admin.mjs <usuario> [--remove]
// QA (DynamoDB):   STORAGE=aws TABLE_NAME=tcg-market-qa BUCKET_NAME=<bucket> AWS_REGION=us-east-1 node scripts/make-admin.mjs <usuario>
const args = process.argv.slice(2);
const username = args.find(a => !a.startsWith('--'));
const remove = args.includes('--remove');
if (!username) {
  console.error('Uso: node scripts/make-admin.mjs <usuario> [--remove]');
  process.exit(1);
}

const { repo, STORAGE } = await import('../storage/index.js');
const user = await repo.findUserByUsername(username);
if (!user) {
  console.error(`No existe el usuario "${username}" (almacenamiento: ${STORAGE}).`);
  process.exit(1);
}
const updated = await repo.setUserAdminFlags(user.id, { role: remove ? '' : 'admin', blocked: remove ? user.blocked : false });
console.log(`@${updated.username} (${updated.display_name}) ${updated.role === 'admin' ? 'ahora es administrador' : 'ya no es administrador'} [${STORAGE}]`);
