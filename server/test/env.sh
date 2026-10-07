export DATABASE_URL=postgresql://postgres@localhost:5433/qb_test DATABASE_SSL=false JWT_SECRET=testsecret PORT=4100 CORS_ORIGIN=http://localhost:5173
export SYSTEM_ADMIN_PASSWORD_HASH=$(node -e "console.log(require('bcryptjs').hashSync('adminpass',4))")
