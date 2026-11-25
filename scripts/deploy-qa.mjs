// Despliega el ambiente QA en AWS (serverless, pago por uso).
// Uso:  node scripts/deploy-qa.mjs
//
// 1. CloudFormation: tabla DynamoDB, bucket S3 privado, grupo de logs (infra/qa.yaml)
// 2. Empaqueta la app con solo dependencias de producción (.build/)
// 3. Crea o actualiza la Lambda Web Function y su endpoint HTTPS
// 4. Da al rol de la función permisos mínimos sobre la tabla y el bucket
//
// Requisitos: AWS CLI v2 reciente (con "aws lambda-web") y credenciales configuradas.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, readdirSync } from 'node:fs';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENV = 'qa';
const STACK = `tcg-market-${ENV}`;
const FUNCTION = `tcg-market-${ENV}`;
const ENDPOINT = ENV;

const aws = (args, opts = {}) => execFileSync('aws', [...args, '--region', REGION, '--no-cli-pager'],
  { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
const awsJson = args => JSON.parse(aws([...args, '--output', 'json']));
const step = msg => console.log(`\n▶ ${msg}`);

function deployStack(roleName = '') {
  aws(['cloudformation', 'deploy', '--stack-name', STACK, '--template-file', 'infra/qa.yaml',
    '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset',
    '--parameter-overrides', `EnvName=${ENV}`, `WebFunctionName=${FUNCTION}`, `WebFunctionRoleName=${roleName}`,
    '--tags', 'app=tcg-market', `env=${ENV}`], { inherit: true });
  const outputs = awsJson(['cloudformation', 'describe-stacks', '--stack-name', STACK])
    .Stacks[0].Outputs.reduce((o, x) => ({ ...o, [x.OutputKey]: x.OutputValue }), {});
  return outputs;
}

function currentRoleName() {
  // El rol vive en cada revisión; se toma el de la más reciente
  try {
    const { revisions = [] } = awsJson(['lambda-web', 'list-web-function-revisions', '--function-name', FUNCTION]);
    const latest = revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest) return '';
    const rev = awsJson(['lambda-web', 'get-web-function-revision', '--function-name', FUNCTION, '--revision-id', latest.revisionId]);
    return rev.serviceConfig?.executionRoleArn?.split('/').pop() || '';
  } catch { return ''; }
}

step(`Infraestructura (${STACK}, ${REGION})`);
const existingRole = currentRoleName();
const out = deployStack(existingRole);
console.log(`  tabla: ${out.TableName}\n  bucket: ${out.BucketName}`);

step('Empaquetando la app');
rmSync('.build', { recursive: true, force: true });
mkdirSync('.build');
// Todo el código de la raíz (*.js) más las carpetas de la app; así un archivo nuevo no se queda fuera
const rootJs = readdirSync('.').filter(f => f.endsWith('.js'));
for (const p of ['package.json', 'package-lock.json', ...rootJs, 'storage', 'public']) cpSync(p, `.build/${p}`, { recursive: true });
console.log(`  incluidos: ${rootJs.join(', ')}, storage/, public/`);
execFileSync(process.platform === 'win32' ? 'npm.cmd ci --omit=dev --no-fund --no-audit' : 'npm ci --omit=dev --no-fund --no-audit',
  { cwd: '.build', stdio: 'inherit', shell: true });

// Seguro: arrancar el paquete tal cual se va a subir; si falta un archivo o dependencia, no se despliega
step('Verificando que el paquete arranca');
await new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, ['server.js'], { cwd: '.build', env: { ...process.env, PORT: '3999', STORAGE: 'local' } });
  let log = '';
  proc.stdout.on('data', d => (log += d)); proc.stderr.on('data', d => (log += d));
  const deadline = Date.now() + 20000;
  const probe = async () => {
    try {
      const r = await fetch('http://127.0.0.1:3999/healthz');
      if (r.ok) { proc.kill(); console.log('  el paquete arranca correctamente'); return resolve(); }
    } catch { /* aún no escucha */ }
    if (proc.exitCode !== null || Date.now() > deadline) { proc.kill(); return reject(new Error(`El paquete no arranca:\n${log}`)); }
    setTimeout(probe, 300);
  };
  probe();
});
rmSync('.build/data', { recursive: true, force: true });
rmSync('.build/uploads', { recursive: true, force: true });

step(`Desplegando la Web Function ${FUNCTION}`);
aws(['lambda-web', 'deploy', '--name', FUNCTION, '--code', '.build', '--create',
  '--runtime', 'nodejs24.x', '--entry-point', 'server.js',
  '--endpoint-name', ENDPOINT, '--auth-type', 'ApplicationManaged',
  '--timeout-seconds', '30',
  '--max-environments', '2', '--rate-limit', '100',   // topes de seguridad para que QA no se dispare en costo
  '--env', 'STORAGE=aws', '--env', `TABLE_NAME=${out.TableName}`, '--env', `BUCKET_NAME=${out.BucketName}`,
  '--env', 'COOKIE_SECURE=true', '--env', 'NODE_ENV=production',
  '--revision-description', `deploy ${new Date().toISOString()}`,
  '--tags', 'app=tcg-market', '--tags', `env=${ENV}`], { inherit: true });

const role = currentRoleName();
if (role && role !== existingRole) {
  step(`Dando permisos a la función (rol ${role})`);
  deployStack(role);
}

rmSync('.build', { recursive: true, force: true });

// ---------- Dominio propio (opcional): QA_DOMAIN=tcg.macai.com.mx y QA_URL=<endpoint de la Web Function> ----------
// Las Web Functions no aceptan dominios propios: se pone CloudFront delante con un certificado de ACM (us-east-1).
// El certificado se valida con un registro DNS que se agrega a mano en el proveedor del dominio (GoDaddy); mientras
// no esté validado, este paso solo muestra qué registro agregar y no detiene el despliegue.
async function setupDomain(domain, endpointUrl) {
  step(`Dominio propio ${domain}`);
  const origin = new URL(endpointUrl).host;
  const certs = awsJson(['acm', 'list-certificates', '--certificate-statuses', 'PENDING_VALIDATION', 'ISSUED']).CertificateSummaryList || [];
  let arn = certs.find(c => c.DomainName === domain)?.CertificateArn;
  if (!arn) {
    arn = awsJson(['acm', 'request-certificate', '--domain-name', domain, '--validation-method', 'DNS',
      '--idempotency-token', `tcgmarket${ENV}`, '--tags', 'Key=app,Value=tcg-market', `Key=env,Value=${ENV}`]).CertificateArn;
    console.log(`  certificado solicitado: ${arn}`);
  }
  // ACM tarda unos segundos en generar el registro de validación
  let cert;
  for (let i = 0; i < 10; i++) {
    cert = awsJson(['acm', 'describe-certificate', '--certificate-arn', arn]).Certificate;
    if (cert.Status === 'ISSUED' || cert.DomainValidationOptions?.[0]?.ResourceRecord) break;
    await new Promise(r => setTimeout(r, 3000));
  }
  if (cert.Status !== 'ISSUED') {
    const rr = cert.DomainValidationOptions?.[0]?.ResourceRecord;
    console.log(`  ⏳ El certificado está ${cert.Status}. Agrega este registro en GoDaddy (DNS de ${domain.split('.').slice(1).join('.')}):`);
    if (rr) console.log(`     Tipo: ${rr.Type}\n     Nombre: ${rr.Name.replace(/\.$/, '')}\n     Valor: ${rr.Value.replace(/\.$/, '')}`);
    console.log('     Cuando AWS lo valide (minutos a un par de horas), vuelve a correr el despliegue para crear CloudFront.');
    return;
  }
  const stack = `tcg-market-${ENV}-domain`;
  aws(['cloudformation', 'deploy', '--stack-name', stack, '--template-file', 'infra/qa-domain.yaml', '--no-fail-on-empty-changeset',
    '--parameter-overrides', `EnvName=${ENV}`, `DomainName=${domain}`, `CertificateArn=${arn}`, `OriginDomain=${origin}`,
    '--tags', 'app=tcg-market', `env=${ENV}`], { inherit: true });
  const outputs = awsJson(['cloudformation', 'describe-stacks', '--stack-name', stack]).Stacks[0].Outputs
    .reduce((o, x) => ({ ...o, [x.OutputKey]: x.OutputValue }), {});
  console.log(`  ✔ CloudFront listo: ${outputs.DistributionDomain}`);
  console.log(`     En GoDaddy, el registro CNAME "${domain.split('.')[0]}" debe apuntar a ${outputs.DistributionDomain}`);
}

if (process.env.QA_DOMAIN && process.env.QA_URL) {
  try { await setupDomain(process.env.QA_DOMAIN, process.env.QA_URL); }
  catch (err) { console.warn(`\n⚠ No se pudo configurar el dominio (la app sí quedó desplegada): ${err.message}`); }
}

console.log('\n✔ QA desplegado. Prueba de humo: node scripts/smoke-test.mjs <URL del endpoint>');
