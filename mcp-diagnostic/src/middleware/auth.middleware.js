import dotenv from 'dotenv';
dotenv.config();

const { MCP_OPS_TOKEN } = process.env;

const AuthMiddleware = (req, res, next) => {
    const token = req.headers?.authorization?.replace(/Bearer /g, '');
    if (!token || token !== MCP_OPS_TOKEN) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    next();
};

export default AuthMiddleware;
