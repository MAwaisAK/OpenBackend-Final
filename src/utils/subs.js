// jobs/subscriptionCron.js
import cron from 'node-cron';
import moment from 'moment-timezone';
import User from '../models/user.js'; // Adjust path if needed
import Notifications from '../models/notifications.js';
import fs from "fs";
import path from "path";

const downloadsRoot = path.join(process.cwd(), "public", "downloads");

function deleteOldFiles(dir, maxAgeMinutes = 15) {
  fs.readdir(dir, (err, subdirs) => {
    if (err) return;

    subdirs.forEach(sub => {
      const subPath = path.join(dir, sub);
      fs.readdir(subPath, (_, files) => {
        files.forEach(file => {
          const filePath = path.join(subPath, file);
          fs.stat(filePath, (_, stats) => {
            const ageMs = Date.now() - stats.mtimeMs;
            if (ageMs > maxAgeMinutes * 60 * 1000) {
              fs.unlink(filePath, () => console.log("🧹 Deleted:", filePath));
            }
          });
        });
      });
    });
  });
}


// Runs every day at midnight Canadian Central Time
cron.schedule('0 0 * * *', async () => {
  const now = moment().tz('America/Toronto'); // Canada Eastern Time Zone
  console.log(`Running subscription check at ${now.format()}`);

  try {
    const users = await User.find({
      subscription: { $ne: 'none' } // only those with a trial or real sub
    });

    for (const user of users) {
      if (!user.subscribed_At) continue;

      const subscribedDate = moment(user.subscribed_At);
      const diffDays = now.diff(subscribedDate, 'days');

      let shouldDeactivate = false;
      let totalDuration = 0;

      if (user.subscription === 'trial') {
        totalDuration = 7;
        shouldDeactivate = diffDays >= 7;
      } else if (user.period === 'month') {
        totalDuration = 30;
        shouldDeactivate = diffDays >= 30;
      } else if (user.period === 'year') {
        totalDuration = 365;
        shouldDeactivate = diffDays >= 365;
      }

      const remainingDays = totalDuration - diffDays;

      // 🔔 Notify 7 days before expiration
      if (remainingDays === 7) {
        const notificationText = `Your ${user.subscription} subscription will expire in 7 days.`;
        await Notifications.updateOne(
          { user: user._id },
          { $addToSet: { type: "7days", data: notificationText } },
          { upsert: true }
        );
        console.log(`Sent 7-day reminder to ${user.email}`);
      }

      if (shouldDeactivate) {
        user.subscription = 'none';
        user.trial_used = true;
        await user.save();

        // 🔔 Notify user about subscription end
        const notificationText = `Your subscription has ended. Please renew to continue accessing premium features.`;
        await Notifications.updateOne(
          { user: user._id },
          { $addToSet: { type: "over", data: notificationText } },
          { upsert: true }
        );

        console.log(`Subscription expired for user: ${user.email}`);
      }
    }

    deleteOldFiles(downloadsRoot);
  } catch (err) {
    console.error('Error running subscription cron:', err);
  }
});

