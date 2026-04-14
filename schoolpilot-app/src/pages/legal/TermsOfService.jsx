export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation */}
      <nav className="bg-slate-900 border-b border-slate-800">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <a href="/" className="flex items-center gap-3 no-underline">
            <svg width="40" height="40" viewBox="0 0 64 64" fill="none">
              <rect width="64" height="64" rx="14" fill="#1e3a5f" />
              <path d="M16 24 L48 32 L16 40 L22 32 Z" fill="#fff" />
              <path d="M22 32 L48 32 L16 40 Z" fill="#eab308" />
            </svg>
            <span className="text-2xl font-bold text-white">Schoolpilot</span>
          </a>
          <a
            href="/"
            className="inline-flex items-center gap-2 text-white hover:bg-white/10 px-4 py-2 rounded-md transition-colors no-underline text-sm"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            Back to Home
          </a>
        </div>
      </nav>

      {/* Content */}
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl font-bold text-slate-900 mb-8">Terms of Service</h1>
        <p className="text-slate-600 mb-8">Last updated: April 13, 2026</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">1. Acceptance of Terms</h2>
            <p className="text-slate-700 leading-relaxed">
              By accessing or using Schoolpilot and its products — ClassPilot, PassPilot, and GoPilot
              (collectively, the "Service") — you agree to be bound by these Terms of Service
              ("Terms"). If you do not agree to these Terms, you may not use the Service. These Terms apply
              to all users, including teachers, school administrators, students, parents, and any other visitors.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">2. Description of Service</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot is a suite of school management tools designed for K-12 educational environments.
              ClassPilot enables teachers to monitor student device activity during instructional time.
              PassPilot provides digital hall pass management for tracking student movement.
              GoPilot streamlines the dismissal process with real-time parent check-in and teacher notifications.
              The Service includes real-time monitoring, Google Classroom integration, and classroom management tools.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">3. Eligibility and Account Registration</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              The Service is intended for use by:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Schools and educational institutions</li>
              <li>Teachers and educators authorized by their school</li>
              <li>School administrators</li>
              <li>Students whose schools have adopted the Service</li>
              <li>Parents and guardians linked to their school's dismissal system</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Individual accounts must be created by school administrators. Users must provide accurate
              information and maintain the security of their account credentials.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">4. Acceptable Use</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              You agree to use the Service only for lawful educational purposes. You may not:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Use the Service to monitor students outside of designated school hours or educational contexts</li>
              <li>Share, distribute, or publicly display student screen captures</li>
              <li>Attempt to access accounts or data belonging to other schools or users</li>
              <li>Use the Service to harass, intimidate, or discriminate against students</li>
              <li>Reverse engineer, decompile, or attempt to extract the source code of the Service</li>
              <li>Use the Service in violation of any applicable laws or regulations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">5. School Responsibilities</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schools using Schoolpilot are responsible for:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Obtaining any required parental consent for student monitoring</li>
              <li>Notifying students and parents about the use of classroom monitoring software</li>
              <li>Ensuring the Service is used in compliance with school policies and applicable laws</li>
              <li>Managing user accounts and access permissions appropriately</li>
              <li>Training staff on appropriate use of monitoring capabilities</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">6. Student Privacy</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot is designed with student privacy as a priority. Monitoring occurs only during
              designated school hours, students receive visual indicators when monitoring is active,
              and screen captures are automatically deleted after a short retention period. For full
              details on how we handle student data, please review our{" "}
              <a href="/privacy" className="text-amber-600 hover:text-amber-700 underline">
                Privacy Policy
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">7. Student Data Ownership and Data Processing</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              All student data, education records, and personally identifiable information (PII) processed
              through the Service remains the <strong>sole property of the school</strong>. Schoolpilot acts
              only as a data processor and "school official" under FERPA, operating under the direct control
              of the school with respect to student records. We claim no ownership, license, or rights to use
              student data beyond providing the Service.
            </p>
            <p className="text-slate-700 leading-relaxed">
              Upon school request, Schoolpilot will execute a Data Processing Agreement (DPA) or sign the
              school's applicable Student Data Privacy Agreement (SDPA) or National Data Privacy Agreement
              (NDPA). The terms of any executed DPA/SDPA/NDPA are <strong>incorporated by reference</strong>
              into these Terms upon execution, and in the event of conflict between these Terms and a signed
              DPA, the DPA controls with respect to student data handling.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">8. Subscription and Payment</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schoolpilot offers subscription-based pricing for schools. By subscribing, you agree to:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Pay all applicable fees according to your selected plan</li>
              <li>Provide accurate billing information</li>
              <li>Automatic renewal unless cancelled before the renewal date</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Pricing and plan details are available on request. We reserve the right to
              modify pricing with 30 days notice.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">9. Intellectual Property</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot and its original content, features, and functionality are owned by Schoolpilot
              and are protected by international copyright, trademark, and other intellectual property
              laws. You may not copy, modify, distribute, or create derivative works based on our
              Service without express written permission.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">10. Third-Party Services</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot integrates with third-party services including Google Classroom and Google
              Workspace for Education. Your use of these integrations is subject to the respective
              third-party terms of service. We are not responsible for the practices or content of
              third-party services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">11. Service Availability</h2>
            <p className="text-slate-700 leading-relaxed">
              We strive to maintain high availability of the Service but do not guarantee uninterrupted
              access. The Service may be temporarily unavailable due to maintenance, updates, or
              circumstances beyond our control. We will make reasonable efforts to provide advance
              notice of scheduled maintenance.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">12. Disclaimer of Warranties</h2>
            <p className="text-slate-700 leading-relaxed">
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
              EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF
              MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT
              WARRANT THAT THE SERVICE WILL BE ERROR-FREE OR UNINTERRUPTED.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">13. Limitation of Liability</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, SCHOOLPILOT SHALL NOT BE LIABLE FOR ANY INDIRECT,
              INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR
              REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL,
              OR OTHER INTANGIBLE LOSSES RESULTING FROM YOUR USE OF THE SERVICE.
            </p>
            <p className="text-slate-700 leading-relaxed">
              <strong>Liability Cap.</strong> IN NO EVENT SHALL SCHOOLPILOT'S AGGREGATE LIABILITY ARISING
              OUT OF OR RELATING TO THESE TERMS OR THE SERVICE EXCEED THE TOTAL FEES PAID BY THE SCHOOL
              TO SCHOOLPILOT IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE
              CLAIM. This limitation applies to all theories of liability, whether based in contract, tort,
              negligence, strict liability, or otherwise. The limitation does <em>not</em> apply to:
              (a) Schoolpilot's indemnification obligations, (b) breach of confidentiality, (c) willful
              misconduct, or (d) liability that cannot be limited by law.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">14. Indemnification</h2>
            <p className="text-slate-700 leading-relaxed">
              You agree to indemnify and hold harmless Schoolpilot and its officers, directors, employees,
              and agents from any claims, damages, losses, liabilities, and expenses (including legal
              fees) arising from your use of the Service or violation of these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">15. Termination</h2>
            <p className="text-slate-700 leading-relaxed">
              We may terminate or suspend your access to the Service immediately, without prior notice,
              for conduct that we believe violates these Terms or is harmful to other users, us, or
              third parties, or for any other reason at our sole discretion. Upon termination, your
              right to use the Service will immediately cease. Data handling on termination is governed
              by our <a href="/privacy" className="text-amber-600 hover:text-amber-700 underline">Privacy Policy</a>,
              which commits to returning or destroying all student data within 30 days of contract end.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">16. Changes to Terms</h2>
            <p className="text-slate-700 leading-relaxed">
              We reserve the right to modify these Terms at any time. We will notify users of material
              changes by posting the updated Terms on our website and updating the "Last updated" date.
              Your continued use of the Service after changes become effective constitutes acceptance
              of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">17. Governing Law and Dispute Resolution</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              <strong>Governing Law.</strong> These Terms shall be governed by and construed in accordance
              with the laws of the <strong>State of Delaware</strong>, without regard to its conflict of
              law provisions. The United Nations Convention on Contracts for the International Sale of
              Goods does not apply.
            </p>
            <p className="text-slate-700 leading-relaxed mb-4">
              <strong>Informal Resolution.</strong> Before filing a claim, you agree to attempt to resolve
              the dispute informally by contacting legal@school-pilot.net. We will attempt to resolve the
              dispute in good faith within thirty (30) days.
            </p>
            <p className="text-slate-700 leading-relaxed mb-4">
              <strong>Binding Arbitration.</strong> Any dispute not resolved informally shall be resolved
              through final and binding arbitration administered by the American Arbitration Association
              (AAA) under its Commercial Arbitration Rules. The arbitration shall take place in Delaware
              (or remotely by mutual agreement). The arbitrator's decision shall be final and enforceable
              in any court of competent jurisdiction.
            </p>
            <p className="text-slate-700 leading-relaxed">
              <strong>Exceptions.</strong> Either party may seek injunctive relief in court for claims
              involving intellectual property infringement, unauthorized access to the Service, or breach
              of confidentiality, without first resorting to arbitration. Public school districts and
              government entities whose governing laws restrict arbitration are exempt from this arbitration
              provision and may pursue claims in a court of competent jurisdiction in their home state.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">18. Force Majeure</h2>
            <p className="text-slate-700 leading-relaxed">
              Neither party shall be liable for any failure or delay in performance under these Terms due
              to causes beyond its reasonable control, including but not limited to acts of God, natural
              disasters, war, terrorism, riots, civil unrest, government actions, pandemics, labor disputes,
              power failures, internet outages, or the failure of third-party service providers (including
              AWS, cloud infrastructure providers, and telecommunications carriers). The affected party
              shall give prompt notice and use reasonable efforts to resume performance.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">19. Assignment</h2>
            <p className="text-slate-700 leading-relaxed">
              You may not assign or transfer these Terms or any rights hereunder without Schoolpilot's prior
              written consent. Schoolpilot may assign these Terms without consent in connection with a merger,
              acquisition, reorganization, or sale of all or substantially all of its assets, provided that
              the assignee assumes all obligations hereunder. Any attempted assignment in violation of this
              section is void.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">20. Severability</h2>
            <p className="text-slate-700 leading-relaxed">
              If any provision of these Terms is held to be invalid, illegal, or unenforceable by a court
              of competent jurisdiction, such provision shall be modified to the minimum extent necessary
              to make it enforceable, or if it cannot be modified, severed from these Terms. The remaining
              provisions shall continue in full force and effect.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">21. Entire Agreement</h2>
            <p className="text-slate-700 leading-relaxed">
              These Terms, together with the <a href="/privacy" className="text-amber-600 hover:text-amber-700 underline">
              Privacy Policy</a>, any executed Data Processing Agreement (DPA) or Student Data Privacy
              Agreement (SDPA/NDPA), and any signed order form or master services agreement, constitute the
              entire agreement between you and Schoolpilot regarding the Service, and supersede all prior
              or contemporaneous communications, proposals, and agreements, whether oral or written. Any
              waiver of any provision of these Terms must be in writing and signed by the waiving party.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">22. Contact Us</h2>
            <p className="text-slate-700 leading-relaxed">
              If you have questions about these Terms of Service, please contact us:
            </p>
            <div className="mt-4 p-4 bg-slate-100 rounded-lg">
              <p className="text-slate-700">
                <strong>Email:</strong> legal@school-pilot.net<br />
                <strong>Support:</strong> info@school-pilot.net
              </p>
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-slate-950 text-slate-400 py-8 mt-12">
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm">&copy; {new Date().getFullYear()} Schoolpilot. All rights reserved.</p>
          <div className="mt-4 space-x-4 text-sm">
            <a href="/privacy" className="hover:text-amber-400 transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-amber-400 transition-colors">Terms of Service</a>
            <a href="/" className="hover:text-amber-400 transition-colors">Home</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
