import pg from 'pg';
import bcrypt from 'bcryptjs';
const {Pool}=pg;
const [email,password]=process.argv.slice(2);
if(!process.env.DATABASE_URL||!email||!password){console.error('Usage: DATABASE_URL=... npm run db:create-admin -- email password');process.exit(1)}
if(password.length<12){console.error('Password must be at least 12 characters');process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined});
try{const hash=await bcrypt.hash(password,12);await pool.query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='admin',active=true,updated_at=now()`,[email.trim().toLowerCase(),hash]);console.log(`Admin ${email} is ready`)}finally{await pool.end()}
