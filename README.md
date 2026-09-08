How to run the code - 
[] npm install
[] npm run dev

things to take care of 
[] node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 
use it for creating session secret
[] In Google Cloud Console:
[] [] Create a project.
[] [] Enable the Gmail API.
[] [] Configure the Google Auth Platform / OAuth consent screen.
[] [] While the app is in testing, add your Gmail address as a test user.
[] [] Create an OAuth client of type Web application.
[] [] Add this authorized redirect URI: http://localhost:3000/auth/google/callback

[] Copy the client ID and secret into .env.

[] This is how you write a query 
"Query: from:billing@example.com subject:invoice
Label: Finance/Invoices" use AND OR NOT accordingly

[] For testing, you need to add yourselves as test users

[] [] Go to Google Cloud Console and select the project where you created the OAuth client for this app.

[] [] Add yourself as a test user
Navigate to:
Google Auth Platform → Audience → Test users → Add users
Add the exact Gmail address you’re using to sign in, then click Save.
If you’re seeing the older interface, look under:
APIs & Services → OAuth consent screen → Test users → Add users
Keep the app’s publishing status set to Testing.

[] [] Try connecting again
Wait a few minutes for the change to take effect, then:
Return to http://localhost:3000.
Click Connect Gmail again.
Select the account you just added.
