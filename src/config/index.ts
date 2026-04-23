// src/config/index.ts

// Barrel Export — en lugar de importar desde cada archivo:
// import appConfig from './config/app.config'
// import databaseConfig from './config/database.config'
// import jwtConfig from './config/jwt.config'

// Solo importas desde un punto:
// import { appConfig, databaseConfig, jwtConfig } from './config'
export { default as appConfig } from './app.config';
export { default as databaseConfig } from './database.config';
export { default as jwtConfig } from './jwt.config';