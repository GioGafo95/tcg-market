// Elige el almacenamiento según el entorno:
//   STORAGE=aws  → DynamoDB (TABLE_NAME) + S3 (BUCKET_NAME)   [ambientes en AWS]
//   por defecto  → SQLite en ./data + archivos en ./uploads    [desarrollo local]
export const STORAGE = process.env.STORAGE === 'aws' ? 'aws' : 'local';

if (STORAGE === 'aws') {
  for (const v of ['TABLE_NAME', 'BUCKET_NAME']) {
    if (!process.env[v]) throw new Error(`Falta la variable de entorno ${v} (STORAGE=aws)`);
  }
}

export const { repo } = STORAGE === 'aws' ? await import('./dynamo.js') : await import('./sqlite.js');
export * from './files.js';
