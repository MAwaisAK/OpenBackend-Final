import Admin from "../../models/admin";
const Boom = require('boom');
import {
	signAccessToken,
	signRefreshToken,
	verifyRefreshToken,
} from "../../helpers/jwt";
const redis = require("../../clients/redis").default;

// Admin Login with access & refresh token logic
export const loginAdmin = async (req, res, next) => {
  const input = req.body;
  console.log(input);
  try {
    // 1. Find admin by username
    const admin = await Admin.findOne({ username: input.username });
    if (!admin) {
      return next(Boom.notFound("Admin not found."));
    }

    // 2. Check password
    const isMatched = await admin.isValidPass(input.password);
    if (!isMatched) {
      return next(Boom.unauthorized("Invalid username or password."));
    }

    // 3. Token expiration based on "rememberMe"
    const tokenExpiry = "1h";

    // 4. Sign tokens
    const accessToken = await signAccessToken(
      { user_id: admin._id, role: admin.role },
      tokenExpiry
    );
    const refreshToken = await signRefreshToken(admin._id);

    // 5. Prepare admin data to return
    const adminData = admin.toObject();
    delete adminData.password;
    delete adminData.__v;

    console.log("Admin logged in data:", { admin: adminData, accessToken, refreshToken });

    // 6. Send response
    res.json({ admin: adminData, accessToken, refreshToken });
  } catch (e) {
    next(e);
  }
};

// at top, after your other exports
export const getCurrentAdmin = async (req, res, next) => {
  try {
    // req.payload.user_id comes from your verifyAccessToken middleware
    const admin = await Admin.findById(req.payload.user_id)
      .select("-password -__v");
    if (!admin) {
      return next(Boom.notFound("Admin not found."));
    }
    res.json({ admin });
  } catch (err) {
    next(err);
  }
};


export const RefreshToken = async (req, res, next) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return next(Boom.badRequest("Refresh token missing."));
  }

  try {
    const user_id = await verifyRefreshToken(refresh_token);
    const accessToken = await signAccessToken(user_id);
    const newRefreshToken = await signRefreshToken(user_id);

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (e) {
    next(e);
  }
};

export const createAdmin = async (req, res, next) => {
  const { username, password, role } = req.body;

  if (req.payload?.role !== "admin") {
    return next(Boom.forbidden("Only super admins can create admins"));
  }

  try {
    const newAdmin = new Admin({ username, password, role });
    await newAdmin.save();
    const adminObj = newAdmin.toObject();
    delete adminObj.password;
    delete adminObj.__v;

    res.json({ message: "Admin created", admin: adminObj });
  } catch (error) {
    next(error);
  }
};

export const updateAdminRole = async (req, res, next) => {
  const { adminId, newRole } = req.body;

  if (req.payload?.role !== "admin") {
    return next(Boom.forbidden("Unauthorized"));
  }

  try {
    const updatedAdmin = await Admin.findByIdAndUpdate(
      adminId,
      { level: newRole },
      { new: true }
    ).select("-password");
    res.json({ message: "Admin role updated", admin: updatedAdmin });
  } catch (error) {
    next(error);
  }
};

export const updateAdminCredentials = async (req, res, next) => {
  const { adminId, username, password } = req.body;

  if (req.payload?.role !== "admin") {
    return next(Boom.forbidden("Unauthorized"));
  }

  try {
    const update = {};
    if (username) update.username = username;
    if (password) update.password = password; // will be hashed by pre-save hook

    const adminDoc = await Admin.findById(adminId);
    if (!adminDoc) return next(Boom.notFound("Admin not found"));

    Object.assign(adminDoc, update);
    await adminDoc.save();

    const adminObj = adminDoc.toObject();
    delete adminObj.password;
    delete adminObj.__v;

    res.json({ message: "Admin updated", admin: adminObj });
  } catch (error) {
    next(error);
  }
};

export const deleteAdmin = async (req, res, next) => {
  const { adminId } = req.params;

  if (req.payload?.role !== "admin") {
    return next(Boom.forbidden("Unauthorized"));
  }

  try {
    await Admin.findByIdAndDelete(adminId);
    res.json({ message: "Admin deleted" });
  } catch (error) {
    next(error);
  }
};

export const getAllAdmins = async (req, res, next) => {
  if (req.payload?.role !== "admin") {
    return next(Boom.forbidden("Unauthorized"));
  }

  try {
    const admins = await Admin.find().select("-password");
    res.json(admins);
  } catch (error) {
    next(error);
  }
};

export const logoutAdmin = async (req, res, next) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return next(Boom.badRequest("Refresh token missing."));
  }

  try {
    const adminId = await verifyRefreshToken(refresh_token);
    if (!adminId) {
      return next(Boom.unauthorized("Invalid refresh token."));
    }

    // Remove the stored refresh token in Redis
    await redis.del(adminId.toString());

    res.json({ message: "Logout successful" });
  } catch (e) {
    console.error("Admin logout error:", e);
    next(e);
  }
};



export default {
	loginAdmin,
  createAdmin,
  getAllAdmins,
  deleteAdmin,
  RefreshToken,
  updateAdminCredentials,
  updateAdminRole,
  logoutAdmin,
  getCurrentAdmin
};