// pages/api/payment/create-payment-intent.js

import Stripe from "stripe";
import Boom from "boom";
import Price from "../../models/price";     // Adjust path as needed
import Payment from "../../models/payment"; // Adjust path as needed
import User from "../../models/user";       // Import the User model

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 1. Create PaymentIntent (and update user on success)
import Course from "../../models/courses"; // Ensure Course model is imported


export const createPaymentIntent = async (req, res, next) => {
  try {
    // Extract parameters from the request body.
    let { amount, packageType, paymentMethodId, userId, price, tokens, period, courseId } = req.body;

    if (!amount || !paymentMethodId || !packageType || !userId) {
      return res.status(400).json({ success: false, message: "Missing required parameters." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    
    // Prevent trial if already used
    if ((packageType === "trial" || packageType === "trail") && user.trial_used) {
      return res.status(400).json({ success: false, message: "Trial already used." });
    }

    // Get the official pricing details from your database.
    const officialPricing = await Price.findOne({});
    if (!officialPricing) {
      return res.status(500).json({ success: false, message: "Pricing not configured." });
    }

    // Recalculate price and tokens based on the package type.
    if (packageType === "small") {
      price = officialPricing.small.price;
      tokens = officialPricing.small.tokens;
      amount = Math.round(price * 100);
    } else if (packageType === "large") {
      price = officialPricing.large.price;
      tokens = officialPricing.large.tokens;
      amount = Math.round(price * 100);
    } else if (packageType === "custom") {
      if (price > 10) {
        return res.status(400).json({ success: false, message: "Custom price cannot exceed $10." });
      }
      const ratio = officialPricing.custom.tokens === 0 
        ? officialPricing.custom.price 
        : (officialPricing.custom.price / officialPricing.custom.tokens);
      tokens = price / ratio;
      amount = Math.round(price * 100);
    } else if (packageType === "basic" || packageType === "premium") {
      // For subscriptions, check period. Default to monthly if not provided.
      const billingPeriod = period === "year" ? "perYear" : "perMonth";
      if (packageType === "basic") {
        price = officialPricing.basic[billingPeriod].price;
        tokens = officialPricing.basic[billingPeriod].tokens;
      } else if (packageType === "premium") {
        price = officialPricing.premium[billingPeriod].price;
        tokens = officialPricing.premium[billingPeriod].tokens;
      }
      amount = Math.round(price * 100);
    } else if (packageType === "trial" || packageType === "trail") {
      price = 0;
      tokens = 0;
      amount = 0;
    } else if (packageType === "course") {
      // Ensure courseId is provided and valid
      if (!courseId) {
        return res.status(400).json({ success: false, message: "Missing course ID for course purchase." });
      }
    
      const course = await Course.findById(courseId);
      if (!course) {
        return res.status(404).json({ success: false, message: "Course not found." });
      }
    
      // Apply discounts based on subscription
      if (user.subscription === "premium") {
        price = 0;
      } else if (user.subscription === "basic") {
        price = course.price * 0.2; // 80% off
      } else {
        price = course.price; // full price
      }
    
      amount = Math.round(price * 100);
      tokens = 0; // No tokens for course purchases
    }
     else {
      return res.status(400).json({ success: false, message: "Invalid package type." });
    }

    // Create the PaymentIntent on Stripe.
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      payment_method_types: ["card"],
      metadata: {
        packageType,
        userId,
        price: price.toString(),
        tokens: tokens.toString(),
        period: period || "month",
        course: packageType === "course" ? courseId : null,
      },
    });

    // Generate a unique simple payment id.
    const paymentCount = await Payment.countDocuments({});
    const uniquePaymentId = `P-${1000 + paymentCount + 1}`;

    // Save a Payment record in your database.
    await Payment.create({
      user: userId,
      data: packageType,
      paymentid: uniquePaymentId,
      payment: price,
      paymentIntentId: paymentIntent.id,
      tokens: tokens.toString(),
      status: "paid",
      period: (packageType === "basic" || packageType === "premium") ? (period || "month") : undefined,
      course: packageType === "course" ? courseId : null,
    });
    

    // Update the User model based on the package type.
    const tokenAmount = Number(tokens);
    if (["small", "large", "custom"].includes(packageType)) {
      await User.findByIdAndUpdate(userId, { $inc: { tokens: tokenAmount } });
    } else if (["trial", "basic", "premium"].includes(packageType)) {
      await User.findByIdAndUpdate(userId, { 
        subscription: packageType,
        period: period,
        subscribed_At: new Date(),
        $inc: { tokens: tokenAmount }
      });
    } else if (packageType === "course") {
      // For course purchases, enroll the user by adding the course to their courses array.
      await User.findByIdAndUpdate(userId, { $push: { courses: courseId } });
      await Course.findByIdAndUpdate(courseId, { $inc: { bought: 1 } });
    }

    return res.status(200).json({
      success: true,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    return next(Boom.internal("Error creating payment intent."));
  }
};

// 2. Get All Payments with Optional Status Filter
export const getAllPaymentsWithStatus = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};

    // 1) Find + populate user and course
    const payments = await Payment.find(filter)
      .populate("user", "username email")    // just bring in username & email
      .populate("course", "title")           // <-- populate your course field
      .lean();                               // get plain objects

    // 2) Map in a courseTitle (or "N/A")
    const updatedPayments = payments.map((p) => ({
      ...p,
      courseTitle: p.course?.title ?? "N/A",
    }));

    return res.status(200).json({ success: true, payments: updatedPayments });
  } catch (err) {
    console.error("Error fetching payments:", err);
    return next(Boom.internal("Error fetching payments."));
  }
};


// 3. Get User-Specific Payments with Optional Status Filter
export const getUserPaymentsWithStatus = async (req, res, next) => {
  try {
    const { userId, status } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: "Missing user id." });
    }
    const query = { user: userId };
    if (status) query.status = status;
    const payments = await Payment.find(query).populate("user");
    return res.status(200).json({ success: true, payments });
  } catch (error) {
    console.error("Error fetching user payments:", error);
    return next(Boom.internal("Error fetching user payments."));
  }
};

// 4. Update Payment Status
export const updatePaymentStatus = async (req, res, next) => {
  try {
    const { paymentId, status } = req.body;
    if (!paymentId || !status) {
      return res.status(400).json({ success: false, message: "Missing required parameters." });
    }
    const payment = await Payment.findByIdAndUpdate(paymentId, { status }, { new: true });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }
    return res.status(200).json({ success: true, payment });
  } catch (error) {
    console.error("Error updating payment status:", error);
    return next(Boom.internal("Error updating payment status."));
  }
};

// 5. Refund Payment (triggered by a refund button on the frontend)
export const refundPayment = async (req, res, next) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) {
      return res.status(400).json({ success: false, message: "Missing payment id." });
    }

    // Retrieve the Payment record
    const payment = await Payment.findById(paymentId).lean();
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }

    const { user: userId, course, tokens, data: packageType, period, paymentIntentId } = payment;

    if (!paymentIntentId) {
      return res.status(400).json({ success: false, message: "No PaymentIntent ID found." });
    }

    // Issue Stripe refund
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
    });

    // === ROLLBACK LOGIC STARTS HERE ===

    // Convert tokens back to number safely
    const tokenAmount = Number(tokens || 0);

    // Undo effects based on package type
    if (["small", "large", "custom"].includes(packageType)) {
      // Remove tokens
      await User.findByIdAndUpdate(userId, { $inc: { tokens: -tokenAmount } });

    } else if (["trial", "basic", "premium"].includes(packageType)) {
      // Reset subscription
      await User.findByIdAndUpdate(userId, {
        $set: { subscription: null, period: null, subscribed_At: null },
        $inc: { tokens: -tokenAmount }
      });

    } else if (packageType === "course") {
      // Remove course enrollment from user
      await User.findByIdAndUpdate(userId, { $pull: { courses: course } });
      // Decrement the course purchase count
      await Course.findByIdAndUpdate(course, { $inc: { bought: -1 } });
    }

    // === ROLLBACK LOGIC ENDS HERE ===

    // Mark payment as refunded
    await Payment.findByIdAndUpdate(paymentId, { status: "refunded" });

    return res.status(200).json({ success: true, refund });

  } catch (error) {
    console.error("Error processing refund:", error);
    return next(Boom.internal("Error processing refund."));
  }
};


export const getRevenueStats = async (req, res, next) => {
  try {
    // 1. Monthly Revenue Chart
    // Group by month and year, summing up revenue from payments with status "paid"
    const monthlyRevenue = await Payment.aggregate([
      { $match: { status: "paid" } },
      {
        $group: {
          _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
          revenue: { $sum: "$payment" },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    // 2. Revenue from Last Week
    // Calculate date for 7 days ago from now
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Find payments from the last 7 days with status "paid"
    const lastWeekPayments = await Payment.find({
      status: "paid",
      createdAt: { $gte: sevenDaysAgo }
    });

    // Sum up the payment amounts to get the revenue of last week
    const lastWeekRevenue = lastWeekPayments.reduce(
      (acc, payment) => acc + payment.payment,
      0
    );

    // 3. Last 7 Payments with the user object populated (only username)
    const last7Payments = await Payment.find({ status: "paid" })
      .sort({ createdAt: -1 })
      .limit(7)
      .populate("user", "username");

    return res.status(200).json({
      success: true,
      monthlyRevenue,
      lastWeekRevenue,
      last7Payments,
    });
  } catch (error) {
    console.error("Error fetching revenue stats:", error);
    return next(Boom.internal("Error fetching revenue stats."));
  }
};


export default {
  createPaymentIntent,
  getAllPaymentsWithStatus,
  getUserPaymentsWithStatus,
  updatePaymentStatus,
  refundPayment,
  getRevenueStats,
};
